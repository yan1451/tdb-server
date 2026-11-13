/**
 * Diagnostico + redirecionamento de conexoes do Google (IPv4 e IPv6) para o listener local, em memoria.
 *  - connect() e ConnectEx(): destinos Google:443 viram 127.0.0.1:8082 (AF_INET) ou ::1:8082 (AF_INET6).
 *  - ConnectEx e capturado via WSAIoctl(SIO_GET_EXTENSION_FUNCTION_POINTER, GUID ConnectEx).
 * Logs: [cx]. Nada e alterado em arquivos do jogo ou do sistema.
 */
'use strict';

function log(msg) {
  console.log('[cx] ' + msg);
  send({ tdb: msg });
}

const main = Process.getModuleByName('TheDayBefore.exe');
const fnamePool = main.base.add(0x7c27980);
const processEvent = main.base.add(0x24077b0);
const ws2 = Process.getModuleByName('ws2_32.dll');

const AF_INET = 2;
const AF_INET6 = 23;
const SIO_GET_EXTENSION_FUNCTION_POINTER = 0xc8000006;
// WSAID_CONNECTEX {25A207B9-DDF3-4660-8EE9-76E58C74063E}
const CONNECTEX_GUID = [0xb9, 0x07, 0xa2, 0x25, 0xf3, 0xdd, 0x60, 0x46, 0x8e, 0xe9, 0x76, 0xe5, 0x8c, 0x74, 0x06, 0x3e];

const EMU_PORT = 443; // terminador TLS (certs\tls_front.py) -> emulador 8081
const SET_VERIFY = main.base.add(0x58ad710); // SSL_CTX_set_verify (fork1: chamado em FUN_1451fdba0)
const LOCAL4 = [127, 0, 0, 1];
const LOCAL6 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
// 10/11: + faixas do Google (AS15169) usadas fora das Americas (ex.: Russia: 64.233, 173.194, 108.177, 209.85). Antes, uma
// reconexao do Firestore para um IP fora da lista ia ao Google de verdade -> "Permission denied on resource project" -> o
// progresso (tutorial etc.) deixava de ser salvo e o jogador voltava sempre para a sala do doutor.
const GOOGLE4 = [[172, 217], [142, 250], [142, 251], [216, 58], [74, 125], [172, 253],
                 [64, 233], [66, 102], [66, 249], [72, 14], [74, 114], [108, 170], [108, 177], [173, 194], [209, 85],
                 [216, 239], [192, 178], [192, 179]];
// Prefixos IPv6 do Google: 2800:3f0::/32, 2001:4860::/32, 2404:6800::/32, 2a00:1450::/32, 2607:f8b0::/32
// (2607:f8b0 = America do Norte; sugerido no PR #1 do GitHub, onde o Firestore resolve para esse bloco)
const GOOGLE6 = [[0x28, 0x00, 0x03, 0xf0], [0x20, 0x01, 0x48, 0x60], [0x24, 0x04, 0x68, 0x00], [0x2a, 0x00, 0x14, 0x50],
                 [0x26, 0x07, 0xf8, 0xb0]];

function isGoogle4(ip) {
  return GOOGLE4.some(function (p) { return ip[0] === p[0] && ip[1] === p[1]; });
}
function isGoogle6(b) {
  return GOOGLE6.some(function (p) { return p.every(function (v, i) { return b[i] === v; }); });
}

// Teste 1: redirecionamento desde o startup (sem gate), para pegar o canal que o gRPC abre ja na inicializacao.
let redirectOn = true;
let naoRedir = 0;

// Reescreve o sockaddr do destino se for Google:443. Retorna um texto para log, ou null.
function redirectSockaddr(sa) {
  const family = sa.readU16();
  const port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
  if (port !== 443) return null;
  if (family === AF_INET) {
    const ip = [sa.add(4).readU8(), sa.add(5).readU8(), sa.add(6).readU8(), sa.add(7).readU8()];
    if (!isGoogle4(ip)) {   // 10/11: registra o que sai para a 443 sem redirecionar (achar faixa nova do Google)
      if (naoRedir < 20 && !(ip[0] === 127)) { naoRedir++; try { send({ tdb: '[cx] 443 NAO redirecionado: ' + ip.join('.') }); } catch (e) {} }
      return null;
    }
    for (let i = 0; i < 4; i++) sa.add(4 + i).writeU8(LOCAL4[i]);
    sa.add(2).writeU8((EMU_PORT >> 8) & 0xff);
    sa.add(3).writeU8(EMU_PORT & 0xff);
    return 'IPv4 ' + ip.join('.') + ':443 -> 127.0.0.1:' + EMU_PORT;
  }
  if (family === AF_INET6) {
    const b = [];
    for (let i = 0; i < 16; i++) b.push(sa.add(8 + i).readU8());
    if (!isGoogle6(b)) return null;
    for (let i = 0; i < 16; i++) sa.add(8 + i).writeU8(LOCAL6[i]);
    sa.add(2).writeU8((EMU_PORT >> 8) & 0xff);
    sa.add(3).writeU8(EMU_PORT & 0xff);
    return 'IPv6 destino Google:443 -> [::1]:' + EMU_PORT;
  }
  return null;
}

function readFNameEntry(comparisonIndex) {
  try {
    const block = (comparisonIndex >>> 16) & 0xffff;
    const offset = comparisonIndex & 0xffff;
    const blockPtr = fnamePool.add(0x10).add(block * 8).readPointer();
    if (blockPtr.isNull()) return null;
    const entry = blockPtr.add(offset * 2);
    const header = entry.readU16();
    const isWide = (header & 1) !== 0;
    const len = header >>> 6;
    if (len <= 0 || len > 1024) return null;
    if (isWide) return entry.add(2).readUtf16String(len);
    return entry.add(2).readUtf8String(len);
  } catch (e) {
    return null;
  }
}

function objectName(obj) {
  try {
    if (!obj || obj.isNull()) return '?';
    const idx = obj.add(0x18).readS32();
    return readFNameEntry(idx >>> 0) || 'idx:' + (idx >>> 0);
  } catch (e) {
    return '?';
  }
}

// 06/11 (modo leve): o hook em ProcessEvent decodificava o nome de TODA UFunction chamada pelo jogo, para sempre.
// Agora ele se solta (detach) assim que liga o redirecionamento: depois disso nao ha mais nada para ele fazer.
// 06/11 (noite): com redirectOn ja true desde o inicio (Teste 1), o hook nunca chegava ao detach e ficava ligado para sempre
// (retornando cedo em toda chamada do ProcessEvent). Agora so e instalado se o redirecionamento comecar desligado.
const peListener = redirectOn ? null : Interceptor.attach(processEvent, {
  onEnter(args) {
    if (redirectOn) return;
    if (objectName(args[1]) === 'PrepareServerList') {
      redirectOn = true;
      log('Refresh detectado: redirecionamento IPv4+IPv6 ligado (hook de ProcessEvent solto)');
      setTimeout(function () { try { peListener.detach(); } catch (e) {} }, 0);
    }
  }
});

// Teste: desliga a verificacao da cadeia no cliente TLS (SSL_VERIFY_NONE = 0) em memoria.
let verifyOff = 0;
Interceptor.attach(SET_VERIFY, {
  onEnter(args) {
    const modeBefore = args[1].toInt32();
    args[1] = ptr(0);
    verifyOff++;
    if (verifyOff <= 3) log('SSL_CTX_set_verify modo ' + modeBefore + ' -> 0 (sem verificacao) #' + verifyOff);
  }
});

// connect(s, name, namelen)
const connectFn = ws2.getExportByName('connect');
Interceptor.attach(connectFn, {
  onEnter(args) {
    if (!redirectOn) return;
    const msg = redirectSockaddr(args[1]);
    if (msg) log('connect ' + msg);
  }
});

// ConnectEx(s, name, namelen, ...) via ponteiro obtido por WSAIoctl
let connectExHooked = false;
function hookConnectEx(addr) {
  if (connectExHooked) return;
  connectExHooked = true;
  log('ConnectEx capturado em ' + addr);
  Interceptor.attach(addr, {
    onEnter(args) {
      if (!redirectOn) return;
      const msg = redirectSockaddr(args[1]);
      if (msg) log('ConnectEx ' + msg);
    },
    onLeave(retval) {
      if (redirectOn) log('ConnectEx retorno=' + retval.toInt32());
    }
  });
}

const wsaIoctl = ws2.getExportByName('WSAIoctl');
Interceptor.attach(wsaIoctl, {
  onEnter(args) {
    this.isConnectEx = false;
    this.outBuf = args[4];
    if ((args[1].toInt32() >>> 0) === SIO_GET_EXTENSION_FUNCTION_POINTER) {
      try {
        const bytes = new Uint8Array(args[2].readByteArray(16));
        this.isConnectEx = CONNECTEX_GUID.every(function (v, i) { return bytes[i] === v; });
      } catch (e) {
        this.isConnectEx = false;
      }
    }
  },
  onLeave(retval) {
    if (this.isConnectEx && retval.toInt32() === 0) {
      hookConnectEx(this.outBuf.readPointer());
    }
  }
});

log('tdb_connectex_test armado (IPv4+IPv6, connect e ConnectEx)');
