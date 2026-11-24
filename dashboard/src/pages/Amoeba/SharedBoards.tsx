import { useState } from "react";
import { FileChartColumn } from "lucide-react";
import type { AmoebaSharedBoard } from "../../api/modules/amoeba";
import SharedBoardPreview from "../../components/StaticBoard/SharedBoardPreview";
import { useServerTimezone } from "../../hooks/useServerTimezone";
import { formatServerYmd } from "../../utils/formatMessageTime";
import styles from "./index.module.less";

export default function SharedBoards({
  boards,
}: {
  boards: AmoebaSharedBoard[];
}) {
  const timezone = useServerTimezone();
  const [preview, setPreview] = useState<AmoebaSharedBoard | null>(null);

  return (
    <>
      <ul className={styles.staticBoardList}>
        {boards.map((board) => (
          <li key={board.id} className={styles.staticBoardRow}>
            <FileChartColumn size={18} aria-hidden="true" />
            <button
              type="button"
              className={styles.staticBoardLink}
              onClick={() => setPreview(board)}
            >
              {board.filename}
            </button>
            <span className={styles.staticBoardDate}>
              {formatServerYmd(board.created_at * 1000, timezone)}
            </span>
          </li>
        ))}
      </ul>
      {preview && (
        <SharedBoardPreview board={preview} onClose={() => setPreview(null)} />
      )}
    </>
  );
}
