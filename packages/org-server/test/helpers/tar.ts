/** Build ustar tar bytes in tests (org-server pack format). */
export function buildTar(files: Array<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const file of files) {
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(file.name);
    header.set(nameBytes.subarray(0, 100), 0);
    header.set(encoder.encode("0000644\0"), 100); // mode
    header.set(encoder.encode("0000000\0"), 108); // uid
    header.set(encoder.encode("0000000\0"), 116); // gid
    const size = encoder.encode(file.content).byteLength;
    const sizeOctal = size.toString(8).padStart(11, "0") + "\0";
    header.set(encoder.encode(sizeOctal), 124);
    header.set(encoder.encode("00000000000\0"), 136); // mtime
    header.set(encoder.encode("        "), 148); // checksum placeholder
    header[156] = 48; // typeflag '0'
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    // checksum: sum of header bytes with checksum field as spaces
    let sum = 0;
    for (const b of header) sum += b;
    const chk = sum.toString(8).padStart(6, "0") + "\0 ";
    header.set(encoder.encode(chk), 148);
    blocks.push(header, encoder.encode(file.content));
    const pad = (512 - (size % 512)) % 512;
    if (pad > 0) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024)); // end-of-archive
  const total = blocks.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.byteLength;
  }
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
