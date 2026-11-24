import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import styles from "./PumpjackLoader.module.less";

/*
 * Beam pumping unit drawn as a four-bar linkage in a 320×190 viewBox.
 * The crank turns at a constant rate; the walking beam angle is solved from
 * the crank pin position each frame, so the pitman arm never detaches.
 */
const PIVOT = { x: 156, y: 58 };
const BEAM_REAR = 92;
const CRANK = { x: 64, y: 132 };
const CRANK_RADIUS = 20;
const PITMAN = 74;
/** Horsehead arc radius, centred on the beam pivot. */
const HEAD_RADIUS = 88;
/** The bridle hangs where the horsehead arc is vertical. */
const WELL_X = PIVOT.x + HEAD_RADIUS;
const CARRIER_REST = 104;
const STUFFING_BOX_TOP = 134;
const PERIOD_MS = 3000;
const START_ANGLE = -Math.PI / 3;

interface Pose {
  crank: number;
  beam: number;
  pin: { x: number; y: number };
  end: { x: number; y: number };
  carrier: number;
}

function poseAt(crank: number): Pose {
  const pin = {
    x: CRANK.x + CRANK_RADIUS * Math.cos(crank),
    y: CRANK.y + CRANK_RADIUS * Math.sin(crank),
  };
  // The beam's rear end sits on two circles: radius BEAM_REAR around the
  // pivot and radius PITMAN around the crank pin. Take the upper intersection.
  const dx = pin.x - PIVOT.x;
  const dy = pin.y - PIVOT.y;
  const distance = Math.hypot(dx, dy);
  const along = (BEAM_REAR ** 2 - PITMAN ** 2 + distance ** 2) / (2 * distance);
  const offset = Math.sqrt(Math.max(0, BEAM_REAR ** 2 - along ** 2));
  const baseX = PIVOT.x + (along * dx) / distance;
  const baseY = PIVOT.y + (along * dy) / distance;
  const offX = (-dy / distance) * offset;
  const offY = (dx / distance) * offset;
  const end =
    offY < 0
      ? { x: baseX + offX, y: baseY + offY }
      : { x: baseX - offX, y: baseY - offY };
  const beam = Math.atan2(PIVOT.y - end.y, PIVOT.x - end.x);
  return { crank, beam, pin, end, carrier: CARRIER_REST + HEAD_RADIUS * beam };
}

const deg = (radians: number) => ((radians * 180) / Math.PI).toFixed(2);
const crankTransform = (angle: number) =>
  `translate(${CRANK.x} ${CRANK.y}) rotate(${deg(angle)})`;
const beamTransform = (angle: number) =>
  `rotate(${deg(angle)} ${PIVOT.x} ${PIVOT.y})`;

const REST = poseAt(START_ANGLE);

export default function PumpjackLoader() {
  const { t } = useTranslation();
  const beamRef = useRef<SVGGElement>(null);
  const crankRef = useRef<SVGGElement>(null);
  const pitmanRef = useRef<SVGLineElement>(null);
  const crankPinRef = useRef<SVGCircleElement>(null);
  const cableRef = useRef<SVGLineElement>(null);
  const carrierRef = useRef<SVGRectElement>(null);
  const rodRef = useRef<SVGLineElement>(null);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const apply = ({ crank, beam, pin, end, carrier }: Pose) => {
      beamRef.current?.setAttribute("transform", beamTransform(beam));
      crankRef.current?.setAttribute("transform", crankTransform(crank));
      pitmanRef.current?.setAttribute("x1", pin.x.toFixed(2));
      pitmanRef.current?.setAttribute("y1", pin.y.toFixed(2));
      pitmanRef.current?.setAttribute("x2", end.x.toFixed(2));
      pitmanRef.current?.setAttribute("y2", end.y.toFixed(2));
      crankPinRef.current?.setAttribute("cx", pin.x.toFixed(2));
      crankPinRef.current?.setAttribute("cy", pin.y.toFixed(2));
      cableRef.current?.setAttribute("y2", carrier.toFixed(2));
      carrierRef.current?.setAttribute("y", carrier.toFixed(2));
      rodRef.current?.setAttribute("y1", (carrier + 3).toFixed(2));
    };
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      apply(poseAt(START_ANGLE + ((now - started) / PERIOD_MS) * 2 * Math.PI));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={styles.loader} role="status">
      <svg
        className={styles.art}
        viewBox="0 0 320 190"
        aria-hidden="true"
        focusable="false"
      >
        <line className={styles.ground} x1="12" y1="168" x2="308" y2="168" />
        <line
          className={styles.groundDash}
          x1="40"
          y1="175"
          x2="282"
          y2="175"
        />

        <rect className={styles.steel} x="34" y="160" width="162" height="8" />
        <path className={styles.steel} d="M44 160 L52 140 H76 L84 160 Z" />
        <path className={styles.post} d="M132 160 L152 64 M180 160 L160 64" />
        <path className={styles.brace} d="M139 126 H173 M146 94 H166" />

        <path className={styles.pipe} d="M249 150 H286 Q292 150 292 156 V168" />
        <path
          className={styles.pipeCore}
          d="M249 150 H286 Q292 150 292 156 V168"
        />
        <path className={styles.flow} d="M249 150 H286 Q292 150 292 156 V168" />
        <rect className={styles.steel} x="230" y="164" width="28" height="4" />
        <rect className={styles.steel} x="239" y="142" width="10" height="22" />
        <rect
          className={styles.housing}
          x="240"
          y={STUFFING_BOX_TOP}
          width="8"
          height="8"
        />

        <line
          ref={cableRef}
          className={styles.cable}
          x1={WELL_X}
          y1={PIVOT.y}
          x2={WELL_X}
          y2={REST.carrier}
        />
        <line
          ref={rodRef}
          className={styles.rod}
          x1={WELL_X}
          y1={REST.carrier + 3}
          x2={WELL_X}
          y2={STUFFING_BOX_TOP}
        />
        <rect
          ref={carrierRef}
          className={styles.carrier}
          x={WELL_X - 8}
          y={REST.carrier}
          width="16"
          height="3"
        />

        <rect
          className={styles.housing}
          x="48"
          y="118"
          width="32"
          height="26"
          rx="5"
        />
        <g ref={crankRef} transform={crankTransform(REST.crank)}>
          <path
            className={styles.weight}
            d="M7.9 -6.2 L23.6 -18.5 A30 30 0 0 1 23.6 18.5 L7.9 6.2 A10 10 0 0 0 7.9 -6.2 Z"
          />
          <rect
            className={styles.arm}
            x="-5"
            y="-4"
            width="30"
            height="8"
            rx="4"
          />
        </g>
        <circle className={styles.hub} cx={CRANK.x} cy={CRANK.y} r="3.5" />
        <line
          ref={pitmanRef}
          className={styles.pitman}
          x1={REST.pin.x}
          y1={REST.pin.y}
          x2={REST.end.x}
          y2={REST.end.y}
        />
        <circle
          ref={crankPinRef}
          className={styles.pin}
          cx={REST.pin.x}
          cy={REST.pin.y}
          r="2.5"
        />

        <rect
          className={styles.housing}
          x="148"
          y="61"
          width="16"
          height="8"
          rx="2"
        />
        <g ref={beamRef} transform={beamTransform(REST.beam)}>
          <rect
            className={styles.beam}
            x="58"
            y="54"
            width="168"
            height="8"
            rx="2"
          />
          <rect
            className={styles.beam}
            x="56"
            y="51"
            width="16"
            height="14"
            rx="3"
          />
          <path
            className={styles.head}
            d="M212 53 L226 36 Q232 32.5 240.2 32.3 A88 88 0 0 1 240.2 83.7 Q232 83.5 226 80 L212 63 Z"
          />
          <circle
            className={styles.pin}
            cx={PIVOT.x - BEAM_REAR}
            cy={PIVOT.y}
            r="2.5"
          />
        </g>
        <circle className={styles.hub} cx={PIVOT.x} cy={PIVOT.y} r="4" />
      </svg>
      <span className={styles.caption}>{t("amoeba.workspace.loading")}</span>
    </div>
  );
}
