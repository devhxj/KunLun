"""Persistent HTML dashboards and their sharing settings."""

from __future__ import annotations

import json
import re
import tempfile
import time
from collections.abc import Set
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from octop.infra.errors import ErrorCode, OctopError

MAX_HTML_BYTES = 12 * 1024 * 1024
BoardVisibility = Literal["owner", "groups", "all"]


@dataclass(frozen=True)
class SharedBoard:
    id: str
    filename: str
    owner_id: int
    created_at: int
    visibility: BoardVisibility = "all"
    group_ids: tuple[str, ...] = ()

    def visible_to(self, user_id: int, groups: Set[str]) -> bool:
        return (
            self.owner_id == user_id
            or self.visibility == "all"
            or (self.visibility == "groups" and not groups.isdisjoint(self.group_ids))
        )


def _validate_html(filename: str, content: bytes) -> str:
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if len(filename) > 180 or not filename.lower().endswith((".html", ".htm")):
        raise OctopError(ErrorCode.SLASH_BAD_ARGS, "expected an HTML filename")
    if len(content) > MAX_HTML_BYTES:
        raise OctopError(ErrorCode.SLASH_BAD_ARGS, "HTML file exceeds 12 MiB")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise OctopError(ErrorCode.SLASH_BAD_ARGS, "HTML file must use UTF-8") from exc
    if not re.search(r"<!doctype\s+html\b|<html[\s>]", text, re.IGNORECASE):
        raise OctopError(ErrorCode.SLASH_BAD_ARGS, "expected a complete HTML document")
    return filename


class SharedBoardStore:
    def __init__(self, root: Path) -> None:
        self._root = root

    def create(
        self,
        filename: str,
        content: bytes,
        owner_id: int,
        visibility: BoardVisibility,
        group_ids: tuple[str, ...],
    ) -> SharedBoard:
        filename = _validate_html(filename, content)
        board = SharedBoard(
            uuid4().hex, filename, owner_id, int(time.time()), visibility, group_ids
        )
        self._root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self._root, prefix=".pending-") as work:
            staged = Path(work) / "board"
            staged.mkdir()
            (staged / "board.html").write_bytes(content)
            (staged / "board.json").write_text(
                json.dumps(asdict(board), ensure_ascii=False), encoding="utf-8"
            )
            staged.rename(self._root / board.id)
        return board

    @staticmethod
    def _load(path: Path) -> SharedBoard:
        data = json.loads(path.read_text(encoding="utf-8"))
        data["group_ids"] = tuple(data.get("group_ids", ()))
        return SharedBoard(**data)

    def get(self, board_id: UUID) -> SharedBoard:
        try:
            return self._load(self._root / board_id.hex / "board.json")
        except FileNotFoundError as exc:
            raise OctopError(ErrorCode.NOT_FOUND, "shared board not found") from exc

    def list(self) -> list[SharedBoard]:
        boards = []
        for path in self._root.glob("*/board.json"):
            try:
                boards.append(self._load(path))
            except FileNotFoundError:
                continue  # Concurrent withdrawal.
        return sorted(boards, key=lambda board: (board.created_at, board.id), reverse=True)

    def read(self, board_id: UUID, *, user_id: int, groups: Set[str]) -> bytes:
        board = self.get(board_id)
        if not board.visible_to(user_id, groups):
            raise OctopError(ErrorCode.NOT_FOUND, "shared board not found")
        try:
            content = (self._root / board_id.hex / "board.html").read_bytes()
        except FileNotFoundError as exc:
            raise OctopError(ErrorCode.NOT_FOUND, "shared board not found") from exc
        # An owner can make a board private and then replace its content.
        # Recheck visibility after reading the replacement.
        if board.owner_id != user_id:
            board = self.get(board_id)
            if not board.visible_to(user_id, groups):
                raise OctopError(ErrorCode.NOT_FOUND, "shared board not found")
        return content

    def _replace_file(self, board_id: UUID, name: str, content: bytes) -> None:
        try:
            with tempfile.TemporaryDirectory(dir=self._root, prefix=".pending-") as work:
                staged = Path(work) / name
                staged.write_bytes(content)
                # A concurrent removal cannot recreate the board directory.
                staged.replace(self._root / board_id.hex / name)
        except FileNotFoundError as exc:
            raise OctopError(ErrorCode.NOT_FOUND, "shared board not found") from exc

    def _require_owner(self, board_id: UUID, user_id: int) -> SharedBoard:
        board = self.get(board_id)
        if board.owner_id != user_id:
            raise OctopError(ErrorCode.FORBIDDEN, "only the owner can edit this board")
        return board

    def replace_html(self, board_id: UUID, user_id: int, filename: str, content: bytes) -> None:
        self._require_owner(board_id, user_id)
        _validate_html(filename, content)
        self._replace_file(board_id, "board.html", content)

    def set_visibility(
        self,
        board_id: UUID,
        user_id: int,
        visibility: BoardVisibility,
        group_ids: tuple[str, ...],
    ) -> SharedBoard:
        board = replace(
            self._require_owner(board_id, user_id), visibility=visibility, group_ids=group_ids
        )
        payload = json.dumps(asdict(board), ensure_ascii=False).encode("utf-8")
        self._replace_file(board_id, "board.json", payload)
        return board

    def remove(self, board_id: UUID, *, user_id: int, admin: bool, groups: Set[str]) -> None:
        path = self._root / board_id.hex
        board = self.get(board_id)
        if board.owner_id != user_id and not (admin and board.visible_to(user_id, groups)):
            raise OctopError(ErrorCode.FORBIDDEN, "only the owner can withdraw this board")
        try:
            with tempfile.TemporaryDirectory(dir=self._root, prefix=".removed-") as work:
                path.rename(Path(work) / "board")
        except FileNotFoundError as exc:
            raise OctopError(ErrorCode.NOT_FOUND, "shared board not found") from exc
