const { Keccak } = require('sha3');

const leftPad = (num, size, char = '0') => {
  let s = num + '';

  while (s.length < size) s = char + s;

  return s;
};

const to32ByteBuffer = (number) => Buffer.from(leftPad(number.toString(16), 64), 'hex');

const from32ByteBuffer = (buffer) => buffer.readUInt32BE(28);

const hash = (buffer) => new Keccak(256).update(buffer).digest();

const hashPacked = (buffers) => hash(Buffer.concat(buffers));

const toHex = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return buffer;

  if (Array.isArray(buffer)) {
    return buffer.map((b) => toHex(b));
  }

  return '0x' + buffer.toString('hex');
};

const toBuffer = (hex) => {
  if (Buffer.isBuffer(hex)) return hex;

  if (Array.isArray(hex)) {
    return hex.map((h) => toBuffer(h));
  }

  return Buffer.from(hex.slice(2), 'hex');
};

module.exports = {
  leftPad,
  to32ByteBuffer,
  from32ByteBuffer,
  hash,
  hashPacked,
  toHex,
  toBuffer,
};
