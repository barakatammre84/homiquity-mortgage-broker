/**
 * Staff document viewer — renders borrower uploads WITHOUT executing them.
 *
 * Never an <iframe>/<embed>/<object>: the download route deliberately forces
 * Content-Disposition: attachment so borrower-uploaded files (crafted
 * HTML/SVG/PDF) cannot run in the browser context (server/routes/documents.ts,
 * "Force download rather than inline render"), and CSP sets object-src 'none'.
 * This component preserves that posture by fetching the bytes and rasterizing:
 * PDFs through the pdfjs canvas renderer (pdfjs-dist 6.x has no eval path at
 * all — the isEvalSupported font-eval option was removed upstream after
 * CVE-2024-4367, so embedded PDF JavaScript never executes), images through a
 * blob <img>. Word documents stay download-only.
 *
 * Default export, lazy-loaded from BorrowerFile, so pdfjs-dist lives in a
 * staff-only async chunk and never reaches borrower bundles.
 */
import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Icons, iconSize } from "@/lib/icons";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const DEFAULT_ZOOM_INDEX = 1; // 100%

type ViewerContent =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "image"; objectUrl: string }
  | { kind: "pdf"; pdf: PDFDocumentProxy; numPages: number }
  | { kind: "download_only" };

interface DocumentViewerProps {
  documentId: string;
  fileName: string;
  mimeType: string | null;
  requestedPage?: {
    pageNumber: number;
    requestId: number;
    boundingBox?: unknown;
    fieldLabel?: string;
  } | null;
}

interface NormalizedBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeEvidenceBox(value: unknown): NormalizedBoundingBox | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const numbers = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  const box = candidate as unknown as NormalizedBoundingBox;
  if (
    box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 ||
    box.x > 1 || box.y > 1 || box.x + box.width > 1.001 || box.y + box.height > 1.001
  ) return null;
  return box;
}

function EvidenceOverlay({ box, label }: { box: NormalizedBoundingBox; label?: string }) {
  return (
    <div
      className="pointer-events-none absolute rounded-sm border-2 border-flare bg-flare/15 ring-2 ring-background"
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`,
      }}
      role="note"
      aria-label={label ? `Source location for ${label}` : "Extracted value source location"}
      data-testid="viewer-evidence-overlay"
    />
  );
}

export default function DocumentViewer({ documentId, fileName, mimeType, requestedPage }: DocumentViewerProps) {
  const [content, setContent] = useState<ViewerContent>({ kind: "loading" });
  const [normalizedSource, setNormalizedSource] = useState<{
    pageNumber: number;
    objectUrl: string;
  } | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const evidenceBox = requestedPage?.pageNumber === pageNum
    ? normalizeEvidenceBox(requestedPage.boundingBox)
    : null;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setNormalizedSource(null);
    if (!requestedPage) return;

    void (async () => {
      try {
        const response = await apiRequest(
          "GET",
          `/api/documents/${documentId}/pages/${requestedPage.pageNumber}/image`,
        );
        const buffer = await response.arrayBuffer();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
        setNormalizedSource({ pageNumber: requestedPage.pageNumber, objectUrl });
      } catch {
        // Documents created before page materialization still use the safe
        // client-side PDF/image renderer below.
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId, requestedPage?.pageNumber, requestedPage?.requestId]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    // In pdfjs 6.x teardown lives on the loading task (aborts network +
    // destroys the worker transport), not on the document proxy.
    let loadingTask: PDFDocumentLoadingTask | null = null;

    setContent({ kind: "loading" });
    setPageNum(1);
    setZoomIndex(DEFAULT_ZOOM_INDEX);

    (async () => {
      const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(fileName);
      const isImage = !!mimeType && mimeType.startsWith("image/");
      if (!isPdf && !isImage) {
        setContent({ kind: "download_only" });
        return;
      }
      try {
        const res = await apiRequest("GET", `/api/documents/${documentId}/download`);
        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        if (isImage) {
          objectUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType ?? "image/*" }));
          setContent({ kind: "image", objectUrl });
          return;
        }
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        const pdf = await loadingTask.promise;
        if (cancelled) return; // cleanup below destroys the task
        setContent({ kind: "pdf", pdf, numPages: pdf.numPages });
      } catch (err) {
        if (cancelled) return;
        setContent({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load the document.",
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (loadingTask) void loadingTask.destroy().catch(() => undefined);
    };
  }, [documentId, fileName, mimeType]);

  useEffect(() => {
    if (content.kind !== "pdf" || !requestedPage) return;
    setPageNum(Math.min(content.numPages, Math.max(1, requestedPage.pageNumber)));
  }, [content, requestedPage]);

  // Rasterize the current PDF page whenever page/zoom/document changes.
  useEffect(() => {
    if (content.kind !== "pdf") return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    (async () => {
      try {
        const page = await content.pdf.getPage(pageNum);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const viewport = page.getViewport({ scale: ZOOM_STEPS[zoomIndex] });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
      } catch (err) {
        // A cancelled render throws RenderingCancelledException — expected on
        // rapid page/zoom changes; anything else is worth surfacing.
        if (!cancelled && !(err instanceof Error && err.name === "RenderingCancelledException")) {
          console.error("[DocumentViewer] PDF render failed:", err);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [content, pageNum, zoomIndex]);

  const downloadFile = () => {
    window.open(`/api/documents/${documentId}/download`, "_blank");
  };

  return (
    <Card data-testid="document-viewer">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="min-w-0 truncate text-base" title={fileName} data-testid="viewer-file-name">
          {fileName}
        </CardTitle>
        <div className="flex shrink-0 items-center gap-1">
          {content.kind === "pdf" && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zoom out"
                disabled={zoomIndex === 0}
                onClick={() => setZoomIndex((z) => Math.max(0, z - 1))}
                data-testid="button-viewer-zoom-out"
              >
                <Icons.zoomOut className={iconSize.inline} />
              </Button>
              <span className="w-12 text-center text-xs text-muted-foreground" data-testid="text-viewer-zoom">
                {Math.round(ZOOM_STEPS[zoomIndex] * 100)}%
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zoom in"
                disabled={zoomIndex === ZOOM_STEPS.length - 1}
                onClick={() => setZoomIndex((z) => Math.min(ZOOM_STEPS.length - 1, z + 1))}
                data-testid="button-viewer-zoom-in"
              >
                <Icons.zoomIn className={iconSize.inline} />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Download file"
            onClick={downloadFile}
            data-testid="button-viewer-download"
          >
            <Icons.download className={iconSize.inline} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {content.kind === "loading" && (
          <div className="space-y-2" data-testid="viewer-loading">
            <Skeleton className="h-[420px] w-full" />
          </div>
        )}

        {content.kind === "error" && (
          <div
            className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
            role="alert"
            data-testid="viewer-error"
          >
            <Icons.warning className={`${iconSize.feature} text-warning-subtle-foreground`} aria-hidden="true" />
            <p>Couldn't load this document for preview.</p>
            <p className="text-xs">{content.message}</p>
            <Button variant="outline" size="sm" className="touch-target" onClick={downloadFile}>
              <Icons.download className={`${iconSize.inline} mr-2`} />
              Download instead
            </Button>
          </div>
        )}

        {content.kind === "download_only" && (
          <div
            className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
            data-testid="viewer-download-only"
          >
            <Icons.document className={iconSize.empty} aria-hidden="true" />
            <p>Inline preview isn't available for this file type.</p>
            <Button variant="outline" size="sm" className="touch-target" onClick={downloadFile} data-testid="button-viewer-download-fallback">
              <Icons.download className={`${iconSize.inline} mr-2`} />
              Download to view
            </Button>
          </div>
        )}

        {content.kind === "image" && (
          <div className="max-h-[560px] overflow-auto rounded-md border" data-testid="viewer-image">
            <div className="relative inline-block max-w-full">
              <img
                src={normalizedSource?.pageNumber === pageNum ? normalizedSource.objectUrl : content.objectUrl}
                alt={`Preview of ${fileName}`}
                className="block max-w-full"
              />
              {evidenceBox && <EvidenceOverlay box={evidenceBox} label={requestedPage?.fieldLabel} />}
            </div>
          </div>
        )}

        {content.kind === "pdf" && (
          <div className="space-y-3" data-testid="viewer-pdf">
            <div className="max-h-[560px] overflow-auto rounded-md border bg-muted/30">
              <div className="relative mx-auto w-fit">
                {normalizedSource?.pageNumber === pageNum ? (
                  <img
                    src={normalizedSource.objectUrl}
                    alt={`Normalized preview of ${fileName}, page ${pageNum} of ${content.numPages}`}
                    className="block max-w-full"
                    data-testid="viewer-normalized-page"
                  />
                ) : (
                  <canvas
                    ref={canvasRef}
                    role="img"
                    aria-label={`Preview of ${fileName}, page ${pageNum} of ${content.numPages}`}
                    className="block"
                    data-testid="viewer-pdf-canvas"
                  />
                )}
                {evidenceBox && <EvidenceOverlay box={evidenceBox} label={requestedPage?.fieldLabel} />}
              </div>
            </div>
            {content.numPages > 1 && (
              <div className="flex items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Previous page"
                  disabled={pageNum <= 1}
                  onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                  data-testid="button-viewer-prev-page"
                >
                  <Icons.navPrev className={iconSize.inline} />
                </Button>
                <span className="text-sm text-muted-foreground" data-testid="text-viewer-page">
                  Page {pageNum} of {content.numPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Next page"
                  disabled={pageNum >= content.numPages}
                  onClick={() => setPageNum((p) => Math.min(content.numPages, p + 1))}
                  data-testid="button-viewer-next-page"
                >
                  <Icons.navNext className={iconSize.inline} />
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
