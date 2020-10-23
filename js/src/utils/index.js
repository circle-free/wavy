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

const prefix = (value) => (value.startsWith('0x') ? value : '0x' + value);

const toHex = (value) => {
  if (typeof value == 'string') return prefix(value);

  if (Array.isArray(value)) {
    return value.map((v) => toHex(v));
  }

  return prefix(Buffer.isBuffer(value) ? value.toString('hex') : value.toString(16));
};

const toBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value;

  if (Array.isArray(value)) {
    return value.map((v) => toBuffer(v));
  }

  return Buffer.from(toHex(value).slice(2), 'hex');
};

const toBigInt = (value) => {
  if (typeof value == 'bigint') return value;

  if (Array.isArray(value)) {
    return value.map((v) => toBigInt(v));
  }

  return BigInt(toHex(v));
};

module.exports = {
  leftPad,
  to32ByteBuffer,
  from32ByteBuffer,
  hash,
  hashPacked,
  toHex,
  toBuffer,
  toBigInt,
};
