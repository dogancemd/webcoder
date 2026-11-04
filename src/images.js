const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function decodeImage(base64) {
  if (typeof base64 !== 'string' || !base64.length) throw new Error('Choose an image to upload.');
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Images must be 5 MB or smaller.');
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('Invalid image data.');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Images must be 5 MB or smaller.');
  let extension;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) extension = 'png';
  else if (buffer.length >= 4 && buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) extension = 'jpg';
  else if (buffer.length >= 13 && /^(GIF87a|GIF89a)$/.test(buffer.toString('ascii', 0, 6))) extension = 'gif';
  else if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  else throw new Error('Use a PNG, JPEG, GIF, or WebP image.');
  return { buffer, extension };
}

async function saveImage(roomId, base64) {
  const { buffer, extension } = decodeImage(base64);
  const directory = path.join(UPLOADS_DIR, roomId);
  await fs.mkdir(directory, { recursive: true });
  const filename = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
  const filePath = path.join(directory, filename);
  await fs.writeFile(filePath, buffer, { flag: 'wx' });
  return { filePath, url: `/api/rooms/${roomId}/images/${filename}` };
}

module.exports = { MAX_IMAGE_BYTES, UPLOADS_DIR, IMAGE_TYPES, decodeImage, saveImage };
