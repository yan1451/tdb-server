'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const scripts = [
  path.join(root, 'scripts', 'tdb_connectex_test.js'),
  path.join(root, 'host', 'scripts', 'tdb_connectex_test.js'),
  path.join(root, 'cliente', 'tdb_connectex_test.js')
];

class Pointer {
  constructor(buffer, offset = 0) { this.buffer = buffer; this.offset = offset; }
  add(offset) { return new Pointer(this.buffer, this.offset + offset); }
  readU8() { return this.buffer.readUInt8(this.offset); }
  readU16() { return this.buffer.readUInt16LE(this.offset); }
  writeU8(value) { this.buffer.writeUInt8(value, this.offset); }
  readByteArray(size) { return this.buffer.subarray(this.offset, this.offset + size); }
}

function loadHooks(file) {
  const hooks = new Map();
  const module = { base: { add: offset => offset }, getExportByName: name => name };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Process: { getModuleByName: () => module },
    Interceptor: { attach: (address, callbacks) => { hooks.set(address, callbacks); } },
    send() {},
    console: { log() {} },
    ptr: value => value
  }, { filename: file });
  const ioctl = hooks.get('WSAIoctl');
  const context = {};
  const guid = new Pointer(Buffer.from('b907a225f3dd60468ee976e58c74063e', 'hex'));
  ioctl.onEnter.call(context, [null, { toInt32: () => 0xc8000006 }, guid, null,
    { readPointer: () => 'ConnectEx' }]);
  ioctl.onLeave.call(context, { toInt32: () => 0 });
  assert.ok(hooks.has('ConnectEx'));
  return hooks;
}

const cases = [
  ['Firestore IPv6 (North America)', 23, '2607f8b040060810000000000000200a', 443, true],
  ['Google IPv6 (South America)', 23, '280003f0000000000000000000000001', 443, true],
  ['Google IPv6 (Europe)', 23, '2a001450000000000000000000000001', 443, true],
  ['Google IPv6 (Asia)', 23, '24046800000000000000000000000001', 443, true],
  ['Google IPv6 (DNS range)', 23, '20014860000000000000000000000001', 443, true],
  ['Firestore IPv4', 2, '8efabc0a', 443, true],
  ['Other IPv6', 23, '26064700000000000000000000001111', 443, false],
  ['Other IPv4', 2, '01010101', 443, false],
  ['IPv6 loopback', 23, '00000000000000000000000000000001', 443, false],
  ['IPv4 loopback', 2, '7f000001', 443, false],
  ['Non-TLS Google IPv6', 23, '2607f8b040060810000000000000200a', 80, false],
  ['Non-TLS Google IPv4', 2, '8efabc0a', 8081, false]
];

for (const file of scripts) {
  const hooks = loadHooks(file);
  for (const api of ['connect', 'ConnectEx']) {
    for (const [name, family, address, port, redirect] of cases) {
      test(`${path.relative(root, file)} ${api}: ${name}`, () => {
        const buffer = Buffer.alloc(family === 2 ? 16 : 28);
        buffer.writeUInt16LE(family, 0);
        buffer.writeUInt16BE(port, 2);
        Buffer.from(address, 'hex').copy(buffer, family === 2 ? 4 : 8);
        const expected = Buffer.from(buffer);
        if (redirect) {
          Buffer.from(family === 2 ? '7f000001' : '00000000000000000000000000000001', 'hex')
            .copy(expected, family === 2 ? 4 : 8);
        }
        hooks.get(api).onEnter([null, new Pointer(buffer)]);
        assert.deepEqual(buffer, expected);
      });
    }
  }
}
