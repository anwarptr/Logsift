/**
 * Minimal ZIP reader: lists entries from the central directory and opens them as
 * byte streams (stored or deflated). Decompression uses the platform's
 * DecompressionStream, so no library is needed. ZIP64 and encryption are not supported.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

async function readBytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

export function isZipName(name: string): boolean {
  return /\.zip$/i.test(name);
}

/** Lists the file entries (directories excluded) of a ZIP archive. */
export async function listZipEntries(zip: Blob): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, zip.size - (22 + MAX_COMMENT));
  const tail = await readBytes(zip, tailStart, zip.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This is not a valid ZIP archive.');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported; extract the files and open them directly.');
  }

  const cd = await readBytes(zip, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== CENTRAL_SIG) {
      throw new ZipError('The ZIP archive is damaged (bad central directory).');
    }
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const compressedSize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localHeaderOffset = cd.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory
    if (flags & 1) throw new ZipError(`"${name}" is encrypted; password-protected archives are not supported.`);
    if (method !== 0 && method !== 8) throw new ZipError(`"${name}" uses an unsupported compression method (${method}).`);
    entries.push({ name, method, compressedSize, size, localHeaderOffset });
  }
  return entries;
}

/** The entry's raw (still compressed) bytes. */
export async function zipEntryData(zip: Blob, entry: ZipEntry): Promise<Blob> {
  const header = await readBytes(zip, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL_SIG) {
    throw new ZipError(`The ZIP archive is damaged (bad header for "${entry.name}").`);
  }
  const start = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  return zip.slice(start, start + entry.compressedSize);
}
