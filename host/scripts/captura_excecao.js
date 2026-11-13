// captura_excecao.js (2026-11-06) - SOMENTE LEITURA. Registra excecoes C++ lancadas (RaiseException 0xE06D7363) com o tipo,
// a mensagem what() (se for std::exception) e o backtrace. Motivo: 2a instancia na mesma conta cai com 0xe06d7363 em KERNELBASE+0xc408a.
// Layout MSVC x64: ExceptionInformation = [magic, pObject, pThrowInfo, imageBase]; ThrowInfo+0x0C = RVA CatchableTypeArray;
// CatchableTypeArray = {int n; int rva[n]}; CatchableType+0x04 = RVA TypeDescriptor; TypeDescriptor+0x10 = nome decorado (".?AV...").
// 10/11: ligado sempre no host; alem do send(), grava NA HORA em %TEMP%\tdb_excecoes.txt (na thread que lancou): numa excecao fatal
// o WER congela o processo e as mensagens do Frida nao saem (queda das 12:37 sem nenhuma linha [exc]). what() pela vtable.
(function () {
'use strict';
let arq = null;
try { arq = new File(Process.getTmpDir() + '/tdb_excecoes.txt', 'a'); } catch (e) {}
function log(m) {
  try { if (arq) { arq.write(new Date().toISOString() + ' pid=' + Process.id + ' [exc] ' + m + '\n'); arq.flush(); } } catch (e) {}
  send({ tdb: '[exc] ' + m });
}
const raise = Process.getModuleByName('KERNELBASE.dll').getExportByName('RaiseException');
let n = 0;
Interceptor.attach(raise, {
  onEnter(a) {
    try {
      if ((a[0].toUInt32() >>> 0) !== 0xE06D7363) return;
      if (++n > 300) return;   // 10/11: 30 -> 300 (o jogo lanca excecoes normais; a fatal pode vir depois)
      const info = a[3], obj = info.add(8).readPointer(), ti = info.add(16).readPointer(), base = info.add(24).readPointer();
      const tipos = [];
      try {
        const cta = base.add(ti.add(0x0c).readS32()), nt = cta.readS32();
        for (let i = 0; i < nt && i < 6; i++) { const ct = base.add(cta.add(4 + i * 4).readS32()); const td = base.add(ct.add(4).readS32()); tipos.push(td.add(0x10).readCString()); }
      } catch (e) { tipos.push('?(' + e + ')'); }
      let what = '';
      // std::exception::what() pela vtable (entrada 1); FirestoreException guarda a mensagem fora de obj+8.
      if (tipos.some(function (t) { return t === '.?AVexception@std@@'; })) {
        try { const fw = new NativeFunction(obj.readPointer().add(8).readPointer(), 'pointer', ['pointer']); const p = fw(obj); if (!p.isNull()) what = p.readCString(4000); } catch (e) { what = '?(' + e + ')'; }
      }
      if (!what) { try { const p = obj.add(8).readPointer(); if (!p.isNull()) what = p.readCString(200); } catch (e) {} }
      const mod = Process.findModuleByAddress(this.returnAddress);
      const bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 12).map(function (x) { const m = Process.findModuleByAddress(x); return m ? m.name + '+0x' + x.sub(m.base).toString(16) : x.toString(); }).join(' < ');
      log('#' + n + ' tipo=' + tipos.join(',') + (what ? ' what="' + what + '"' : '') + ' de ' + (mod ? mod.name : '?') + ' | bt: ' + bt);
    } catch (e) { log('erro: ' + e); }
  }
});
// 10/11 13:0x: o Offline pelo launcher cai com "Failed to open LevelDB database" sem nem tocar no LOG do banco. Registra toda falha
// de abrir/criar/renomear arquivo do Firestore (caminho com "firestore") com o codigo do Windows (32 = em uso, 5 = negado, 3 = caminho).
let nArq = 0;
function vigiaArquivo(nome, falhou) {
  let f = null;
  try { f = Process.getModuleByName('KERNELBASE.dll').getExportByName(nome); } catch (e) { try { f = Process.getModuleByName('kernel32.dll').getExportByName(nome); } catch (e2) {} }
  if (!f) return;
  Interceptor.attach(f, {
    onEnter(a) { this.c = null; try { const c = a[0].readUtf16String(); if (c && c.toLowerCase().indexOf('firestore') >= 0) this.c = c; } catch (e) {} },
    onLeave(r) {
      if (!this.c || nArq > 200) return;
      if (falhou(r)) { nArq++; log('ARQUIVO FALHOU ' + nome + ' erro=' + this.lastError + ' ' + this.c); }
    }
  });
}
vigiaArquivo('CreateFileW', function (r) { return r.equals(ptr('-1')); });
vigiaArquivo('CreateDirectoryW', function (r) { return r.toInt32() === 0; });
vigiaArquivo('MoveFileExW', function (r) { return r.toInt32() === 0; });
vigiaArquivo('DeleteFileW', function (r) { return r.toInt32() === 0; });
log('pronto: excecoes C++ (RaiseException 0xE06D7363) e falhas de arquivo do Firestore');
})();
