import type { ComponentPropsWithoutRef } from "react";
import { publicUrl } from "../utils/publicUrl";

const mascotSrc = publicUrl("kunlun-worker-empty.svg");

interface KunlunMascotProps
  extends Omit<ComponentPropsWithoutRef<"img">, "src" | "alt" | "draggable"> {
  focused?: boolean;
}

export default function KunlunMascot({
  focused = false,
  ...imageProps
}: KunlunMascotProps) {
  return (
    <picture style={{ display: "contents" }}>
      <source
        media="(prefers-reduced-motion: reduce)"
        srcSet={`${mascotSrc}#still`}
      />
      <img
        src={focused ? `${mascotSrc}#focused` : mascotSrc}
        alt=""
        draggable={false}
        {...imageProps}
      />
    </picture>
  );
}
