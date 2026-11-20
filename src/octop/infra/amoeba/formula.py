"""Safe arithmetic evaluation for derived-metric formulas.

Formulas are plain arithmetic over metric keys (``oil = gas + die``) with an
optional ``{{days}}`` placeholder bound to the in-progress day count of the
selected dimension. Anything outside numbers, ``+ - * /`` and parentheses is
rejected at parse time; division by zero yields ``None`` so the UI can show a
dash instead of a bogus value.
"""

from __future__ import annotations

import ast
import operator
import re
from typing import Any

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}")

_BIN_OPS: dict[type[ast.operator], Any] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
}


class FormulaError(ValueError):
    """Raised when a stored formula cannot be parsed or references an unknown name."""


def _bind_placeholders(formula: str, extra: dict[str, float] | None) -> str:
    """Replace ``{{name}}`` placeholders with their bound numeric literals."""

    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        if extra and name in extra:
            return repr(float(extra[name]))
        return "1"  # unbound placeholders neutralize to a harmless constant

    return _PLACEHOLDER_RE.sub(repl, formula)


def evaluate_formula(
    formula: str, values: dict[str, float | None], *, extra: dict[str, float] | None = None
) -> float | None:
    """Evaluate ``formula`` against rolled-up absolute values.

    ``values`` maps metric keys to their rolled-up sums (missing = 0, matching
    the source semantics of "no rows = no activity"); a ``None`` value (e.g.
    from an upstream division by zero) propagates through the expression.
    ``extra`` binds the ``{{days}}``-style placeholders. Returns ``None`` when a
    division by zero occurs anywhere in the expression.
    """
    expr = (formula or "").strip()
    if not expr:
        return None
    expr = _bind_placeholders(expr, extra)
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"bad formula syntax: {formula!r}") from exc
    return _eval_node(tree.body, values)


def _eval_node(node: ast.AST, values: dict[str, float | None]) -> float | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.Name):
        if node.id not in values:
            raise FormulaError(f"formula references unknown metric: {node.id}")
        val = values[node.id]
        return None if val is None else float(val)
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        left = _eval_node(node.left, values)
        right = _eval_node(node.right, values)
        if left is None or right is None:
            return None
        if isinstance(node.op, ast.Div) and right == 0:
            return None
        return float(_BIN_OPS[type(node.op)](left, right))
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        inner = _eval_node(node.operand, values)
        return None if inner is None else -inner
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.UAdd):
        return _eval_node(node.operand, values)
    raise FormulaError(f"unsupported formula element: {ast.dump(node)[:60]}")


def formula_dependencies(formula: str) -> list[str]:
    """Metric keys referenced by ``formula`` (placeholders excluded).

    Also enforces the node whitelist, so anything beyond numbers, metric
    names, ``+ - * /`` and parentheses raises :class:`FormulaError`.
    """
    expr = (formula or "").strip()
    if not expr:
        return []
    expr = _bind_placeholders(expr, None)
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"bad formula syntax: {formula!r}") from exc
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Expression):
            continue
        if isinstance(node, ast.operator | ast.unaryop | ast.expr_context):
            # The parent BinOp/UnaryOp branches below validate these.
            continue
        if isinstance(node, ast.Constant):
            if not isinstance(node.value, (int, float)):
                raise FormulaError(f"non-numeric constant in formula: {node.value!r}")
            continue
        if isinstance(node, ast.Name):
            names.append(node.id)
            continue
        if isinstance(node, ast.BinOp):
            if type(node.op) not in _BIN_OPS:
                raise FormulaError("operator not allowed in formula")
            continue
        if isinstance(node, ast.UnaryOp):
            if not isinstance(node.op, ast.USub | ast.UAdd):
                raise FormulaError("operator not allowed in formula")
            continue
        raise FormulaError(f"unsupported formula element: {type(node).__name__}")
    return names


__all__ = ["FormulaError", "evaluate_formula", "formula_dependencies"]
