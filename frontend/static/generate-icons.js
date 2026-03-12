// Generate simple PNG icons using pure JavaScript (no deps)
// Creates 1x1 solid color PNGs that work as placeholders

function createMinimalPNG(size) {
  // This creates a minimal valid PNG file with a solid dark background
  // Using raw PNG construction
  
  const width = size;
  const height = size;
  
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = createChunk('IHDR', ihdrData);
  
  // IDAT chunk - raw image data
  // Each row: filter byte (0) + RGB pixels
  const rawData = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    rawData[rowStart] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      // Simple gradient M logo effect
      const cx = (x / width - 0.5) * 2;
      const cy = (y / height - 0.5) * 2;
      const dist = Math.sqrt(cx * cx + cy * cy);
      
      if (dist < 0.7) {
        // Inner circle - accent color (#ff6b35 orange)
        rawData[px] = 255;
        rawData[px + 1] = 107;
        rawData[px + 2] = 53;
      } else if (dist < 0.8) {
        // Ring
        rawData[px] = 20;
        rawData[px + 1] = 20;
        rawData[px + 2] = 20;
      } else {
        // Background
        rawData[px] = 12;
        rawData[px + 1] = 12;
        rawData[px + 2] = 12;
      }
    }
  }
  
  // Compress with zlib
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawData);
  const idat = createChunk('IDAT', compressed);
  
  // IEND chunk
  const iend = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);
  
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const fs = require('fs');
fs.writeFileSync('icon-192.png', createMinimalPNG(192));
fs.writeFileSync('icon-512.png', createMinimalPNG(512));
fs.writeFileSync('favicon.png', createMinimalPNG(32));
console.log('Generated icon-192.png, icon-512.png, favicon.png');
