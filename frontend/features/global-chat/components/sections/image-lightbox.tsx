"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

// 轻量图片点击放大预览（基于 Dialog，天然支持 Esc 关闭与焦点管理）。
export function ImageLightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(src)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        className="max-h-none max-w-none w-auto border-none bg-black/85 p-4 backdrop-blur-none sm:max-w-none"
        onInteractOutside={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <DialogTitle className="sr-only">image preview</DialogTitle>
        {src ? (
          <img src={src} alt="" className="max-h-[85svh] max-w-[85svw] object-contain" draggable={false} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
