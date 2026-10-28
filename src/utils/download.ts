/** Trigger a browser download of text parts without building one giant string. */
export function downloadParts(parts: string[], filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
