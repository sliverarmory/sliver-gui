// Authenticode permits the PE checksum and Certificate Table data-directory
// entry to change and appends a WIN_CERTIFICATE record outside the image.
// Compare every other source byte, including existing overlay data, exactly.
export function verifyWindowsSigningChanges(unsigned, signed) {
  const header = portableExecutableHeader(unsigned);
  const signedHeader = portableExecutableHeader(signed);
  if (header.checksum !== signedHeader.checksum || header.securityDirectory !== signedHeader.securityDirectory) {
    throw new Error("Windows signing changed the PE header layout");
  }
  if (unsigned.readUInt32LE(header.securityDirectory) !== 0 || unsigned.readUInt32LE(header.securityDirectory + 4) !== 0) {
    throw new Error("Windows signing provenance requires an unsigned source executable");
  }
  const certificateOffset = signed.readUInt32LE(header.securityDirectory);
  const certificateSize = signed.readUInt32LE(header.securityDirectory + 4);
  const expectedOffset = align8(unsigned.length);
  if (certificateOffset !== expectedOffset || certificateSize < 8 ||
      certificateSize % 8 !== 0 || certificateOffset + certificateSize !== signed.length) {
    throw new Error("Windows signing must append exactly one aligned certificate table after the complete source payload");
  }
  if (!isZero(signed.subarray(unsigned.length, certificateOffset))) {
    throw new Error("Windows signing added nonzero bytes before its certificate table");
  }
  const recordLength = signed.readUInt32LE(certificateOffset);
  if (recordLength < 8 || align8(recordLength) !== certificateSize ||
      signed.readUInt16LE(certificateOffset + 4) !== 0x0200 ||
      signed.readUInt16LE(certificateOffset + 6) !== 0x0002 ||
      !isZero(signed.subarray(certificateOffset + recordLength))) {
    throw new Error("Windows signing appended an invalid WIN_CERTIFICATE record");
  }
  const before = Buffer.from(unsigned);
  const after = Buffer.from(signed.subarray(0, unsigned.length));
  for (const bytes of [before, after]) {
    bytes.fill(0, header.checksum, header.checksum + 4);
    bytes.fill(0, header.securityDirectory, header.securityDirectory + 8);
  }
  if (!before.equals(after)) {
    throw new Error("Windows signing changed executable bytes outside Authenticode fields");
  }
}

function portableExecutableHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Windows signing requires a valid PE executable");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 24 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error("Windows signing requires a valid PE header");
  }
  const optional = peOffset + 24;
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  if (optionalSize < 2 || optional + optionalSize > bytes.length) {
    throw new Error("Windows signing requires a complete PE optional header");
  }
  const magic = bytes.readUInt16LE(optional);
  const directoriesOffset = magic === 0x020b ? 112 : magic === 0x010b ? 96 : undefined;
  if (directoriesOffset === undefined || optionalSize < directoriesOffset + 5 * 8 ||
      bytes.readUInt32LE(optional + directoriesOffset - 4) < 5) {
    throw new Error("Windows signing requires a Certificate Table data-directory entry");
  }
  return { checksum: optional + 64, securityDirectory: optional + directoriesOffset + 4 * 8 };
}

function align8(value) {
  return Math.ceil(value / 8) * 8;
}

function isZero(bytes) {
  return bytes.every((byte) => byte === 0);
}
