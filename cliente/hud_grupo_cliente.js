// hud_grupo_cliente.js (2026-11-12, PROTOTIPO) - CLIENTE: mostra o grupo (squad) no canto da tela.
// Dados (validados 12/11): PS_TDB_C.SquadId +0x3B8, PartyOwner +0x438 (lider), MySquad (TArray<APS_TDB_C*>) +0x420, nome (PlayerNamePrivate) +0x388.
// Desenho: gancho NATIVO (CModule) em ProcessEvent; quando o BP_GameHUD processa ReceiveDrawHUD (todo quadro, na thread do jogo) chama
// AHUD::DrawText (UFunction, com Canvas valido) uma vez por linha, com parametros ja prontos na memoria. O JS so atualiza o texto a cada 2 s.
// Nao cria widgets, nao escreve em objetos do jogo (so no proprio buffer). Ao desanexar do Frida o gancho some.
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[hud] ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nome(o) { try { return fn(o.add(0x18).readU32()); } catch (e) { return '?'; } }
function classe(o) { try { return nome(o.add(0x10).readPointer()); } catch (e) { return '?'; } }
function fstr(p) { try { const d = p.readPointer(), n = p.add(8).readS32(); return (d.isNull() || n <= 0) ? '' : d.readUtf16String(Math.min(n, 60)); } catch (e) { return '?'; } }
// carregado ao ABRIR o jogo (antes de a GObjects existir): o ponteiro/contagem sao relidos a cada busca
const g = B.add(0x7ccda10); let objs = ptr(0), num = 0, nch = 0;
function refrescar() { try { objs = g.readPointer(); num = g.add(0x14).readS32(); nch = g.add(0x1c).readS32(); } catch (e) { num = 0; } return num > 100000 && !objs.isNull(); }
const MORTO = (1 << 28) | (1 << 29) | (1 << 21);
const MAXL = 6, CAP = 64;
// Idioma: o carregador troca __IDIOMA__ pelo idioma escolhido no launcher (pt/en/es/ru); sem troca, ingles.
const IDIOMA_CFG = '__IDIOMA__';
const TXT = {
  pt: { grupo: 'GRUPO', lider: 'lider', morto: 'MORTO' },
  en: { grupo: 'GROUP', lider: 'leader', morto: 'DEAD' },
  es: { grupo: 'GRUPO', lider: 'líder', morto: 'MUERTO' },
  ru: { grupo: 'ГРУППА', lider: 'лидер', morto: 'МЁРТВ' }
};
const T = TXT[IDIOMA_CFG] || TXT.en;

// memoria compartilhada com o C: cfg[0] hud, cfg[1] fReceiveDrawHUD, cfg[2] fDrawText, cfg[3] ligado, cfg[4] nLinhas, cfg[5] ProcessEvent, cfg[6] contador de quadros
const cfg = Memory.alloc(10 * 8); for (let i = 0; i < 10; i++) cfg.add(i * 8).writeU64(0);
const MAXR = 12, rct = Memory.alloc(MAXR * 0x20);   // HUD_DrawRect por retangulo (0x20); cfg[7] = quantidade, cfg[8] = UFunction DrawRect
const lin = Memory.alloc(MAXL * 0x40);                  // HUD_DrawText por linha (0x38)
const txt = Memory.alloc(MAXL * CAP * 2);               // texto UTF-16 por linha
for (let k = 0; k < MAXL; k++) {
  const p = lin.add(k * 0x40); p.writeByteArray(new Array(0x40).fill(0));
  p.writePointer(txt.add(k * CAP * 2)); p.add(8).writeS32(0); p.add(12).writeS32(CAP);
  p.add(0x10).writeFloat(1.0); p.add(0x14).writeFloat(1.0); p.add(0x18).writeFloat(1.0); p.add(0x1c).writeFloat(1.0);   // branco
  p.add(0x20).writeFloat(30.0); p.add(0x24).writeFloat(300.0 + k * 22.0);                                               // X, Y
  p.add(0x30).writeFloat(1.0); p.add(0x34).writeU8(0);                                                                  // escala, bScalePosition
}
function linha(k, s, lider, y) {
  const p = lin.add(k * 0x40), t = txt.add(k * CAP * 2); if (y !== undefined) p.add(0x24).writeFloat(y);
  s = s.slice(0, CAP - 1); t.writeUtf16String(s); p.add(8).writeS32(s.length + 1);
  p.add(0x10).writeFloat(lider ? 1.0 : 0.85); p.add(0x14).writeFloat(lider ? 0.85 : 1.0); p.add(0x18).writeFloat(lider ? 0.2 : 0.85);
}

function ret(k, r, g, b, a, x, y, w, h) {
  const p = rct.add(k * 0x20);
  p.writeFloat(r); p.add(4).writeFloat(g); p.add(8).writeFloat(b); p.add(12).writeFloat(a);
  p.add(0x10).writeFloat(x); p.add(0x14).writeFloat(y); p.add(0x18).writeFloat(w); p.add(0x1c).writeFloat(h);
}
const BX = 30, BW = 130, BH = 6, COR_VIDA = [0.348, 0.325, 0.255];
const cm = new CModule(`
#include <gum/guminterceptor.h>
#include <stdint.h>
extern uint64_t cfg[10];
extern uint8_t lin[];
extern uint8_t rct[];
typedef void (*PE) (void *, void *, void *);
void onEnter (GumInvocationContext * ic)
{
  void * o = gum_invocation_context_get_nth_argument (ic, 0);
  void * f = gum_invocation_context_get_nth_argument (ic, 1);
  if (f != 0 && f == (void *) cfg[1] && o == (void *) cfg[0])
  {
    int k, n = (int) cfg[4];
    cfg[6]++;
    if (cfg[3] && cfg[5] != 0)
      for (k = 0; k < n && k < 6; k++) ((PE) cfg[5]) (o, (void *) cfg[2], lin + k * 0x40);
    if (cfg[3] && cfg[5] != 0 && cfg[8] != 0)
    {
      int r = (int) cfg[7];
      for (k = 0; k < r && k < 12; k++) ((PE) cfg[5]) (o, (void *) cfg[8], rct + k * 0x20);
    }
  }
}
`, { cfg, lin, rct });

// 1) achar o BP_GameHUD_C vivo e as UFunctions (varredura em fatias; nao trava o jogo)
let i = 0, hud = ptr(0);
function acharFuncao(o, alvo) {
  let cls = o.add(0x10).readPointer();
  for (let n = 0; n < 8 && !cls.isNull(); n++) { let x = cls.add(0x48).readPointer(); for (let k = 0; k < 3000 && !x.isNull(); k++) { if (nome(x) === alvo) return x; x = x.add(0x28).readPointer(); } cls = cls.add(0x40).readPointer(); }
  return ptr(0);
}
let anexado = false, buscando = false;
function passoHud() {
  if (i === 0 && !refrescar()) { setTimeout(passoHud, 3000); return; }
  buscando = true;
  const fim = Math.min(i + 3000, num);
  for (; i < fim; i++) {
    try {
      const ch = i >> 16; if (ch >= nch) { i = num; break; }
      const chunk = objs.add(ch * 8).readPointer(); if (chunk.isNull()) continue;
      const it = chunk.add((i & 0xffff) * 0x18); const o = it.readPointer(); if (o.isNull()) continue;
      if (it.add(8).readS32() & MORTO) continue; if (o.add(8).readS32() & 0x10) continue;
      if (classe(o) === 'BP_GameHUD_C') { hud = o; i = num; break; }
    } catch (e) {}
  }
  if (hud.isNull() && i < num) { setTimeout(passoHud, 25); return; }
  if (hud.isNull()) { i = 0; buscando = false; setTimeout(passoHud, 3000); return; }   // ainda no menu: tenta de novo
  const fR = acharFuncao(hud, 'ReceiveDrawHUD'), fT = acharFuncao(hud, 'DrawText'), fRc = acharFuncao(hud, 'DrawRect');
  if (fR.isNull() || fT.isNull()) { log('funcao nao achada; nada feito'); hud = ptr(0); i = 0; buscando = false; setTimeout(passoHud, 5000); return; }
  cfg.writeU64(uint64(hud.toString())); cfg.add(8).writeU64(uint64(fR.toString())); cfg.add(16).writeU64(uint64(fT.toString()));
  cfg.add(40).writeU64(uint64(B.add(0x24077b0).toString()));
  if (!fRc.isNull()) cfg.add(64).writeU64(uint64(fRc.toString())); else log('DrawRect nao achada: sem barras');
  buscando = false;
  if (!anexado) {
    anexado = true;
    Interceptor.attach(B.add(0x24077b0), cm);
    setInterval(atualizar, 300); setInterval(reescanear, 20000); setInterval(vigiar, 5000);
    log('HUD do grupo ativa (hud ' + hud + ')');
  } else log('HUD do grupo reativada (novo hud ' + hud + ')');
  cfg.add(24).writeU64(1); reescanear();
}
// o BP_GameHUD e recriado ao trocar de mapa: se o objeto morreu, desliga o desenho e procura o novo
function vigiar() {
  try {
    if (buscando || hud.isNull()) return;
    if (classe(hud) !== 'BP_GameHUD_C') { cfg.add(24).writeU64(0); cfg.add(32).writeU64(0); cfg.add(56).writeU64(0); hud = ptr(0); i = 0; setTimeout(passoHud, 500); }
  } catch (e) {}
}

// 2) membros do grupo: PS_TDB_C vivos (varredura em fatias a cada 20 s) + leitura barata a cada 2 s
let pss = [], pws = [], j = 0, varrendo = false, novos = [], novosP = [];
function reescanear() { if (varrendo || !refrescar()) return; varrendo = true; j = 0; novos = []; novosP = []; passoPS(); }
function passoPS() {
  const fim = Math.min(j + 3000, num);
  for (; j < fim; j++) {
    try {
      const ch = j >> 16; if (ch >= nch) { j = num; break; }
      const chunk = objs.add(ch * 8).readPointer(); if (chunk.isNull()) continue;
      const it = chunk.add((j & 0xffff) * 0x18); const o = it.readPointer(); if (o.isNull()) continue;
      if (it.add(8).readS32() & MORTO) continue; if (o.add(8).readS32() & 0x10) continue;
      const cn = classe(o);
      if (cn === 'PS_TDB_C') novos.push(o);
      else if (cn === 'SurvivalPlayer_V2_C' && !o.add(0x898).readPointer().isNull()) novosP.push(o);
    } catch (e) {}
  }
  if (j < num) { setTimeout(passoPS, 25); return; }
  pss = novos; pws = novosP; varrendo = false;
}
let ultimo = '';
// HP: BPC_PlayerStatsComponent (pawn+0x898).Stats (TMap<EStatType,double> +0x180; passo 0x18): chave 1 = Health, 2 = HealthMax (CalculateHealthMax usa SetStat(2)).
function hpDe(ps) {
  try {
    for (const p of pws) {
      if (!p.add(0x2B0).readPointer().equals(ps)) continue;
      if (classe(p) !== 'SurvivalPlayer_V2_C') continue;
      const comp = p.add(0x898).readPointer(), m = comp.add(0x180), data = m.readPointer(), n = m.add(8).readS32();
      let h = null, mx = null;
      for (let k = 0; k < n && k < 40; k++) { const e = data.add(k * 0x18), key = e.readU8(); if (key === 1) h = e.add(8).readDouble(); else if (key === 2) mx = e.add(8).readDouble(); }
      if (comp.add(0x1D0).readU8() !== 0) return { morto: true, f: 0 };
      if (h === null || !isFinite(h)) return null;
      const f = (mx !== null && isFinite(mx) && mx > 0) ? h / mx : h / 100;
      return { morto: false, f: Math.max(0, Math.min(1, f)), h: Math.round(h) };
    }
  } catch (e) {}
  return null;
}
function atualizar() {
  try {
    let n = 0, nr = 0, resumo = '';
    const vivos = pss.filter(o => classe(o) === 'PS_TDB_C');
    for (const o of vivos) {
      if (o.add(0x3B8).readS32() === 0) continue;
      const arr = o.add(0x420).readPointer(), cnt = o.add(0x428).readS32();
      if (cnt <= 0) continue;
      linha(0, T.grupo + ' (' + cnt + ')', false, 300); n = 1; nr = 0;
      for (let k = 0; k < cnt && n < MAXL; k++) {
        const m = arr.add(k * 8).readPointer(); if (m.isNull()) continue;
        const ld = m.add(0x438).readU8() !== 0, y = 322 + (n - 1) * 32, hp = hpDe(m);
        linha(n, (ld ? '* ' : '- ') + (fstr(m.add(0x3C0)) || fstr(m.add(0x388)) || '?') + (ld ? ' (' + T.lider + ')' : '') + (hp && hp.morto ? '  ' + T.morto : ''), ld, y); n++;
        if (hp && nr + 2 <= MAXR) {
          ret(nr++, 0, 0, 0, 0.65, BX - 1, y + 21, BW + 2, BH + 2);
          const f = hp.f, rg = COR_VIDA;   // mesma cor da barra de vida do proprio jogo (pixel 158,153,138 da HUD, convertido de sRGB para linear)
          ret(nr++, rg[0], rg[1], rg[2], 0.95, BX, y + 22, Math.max(1, BW * f), BH);
        }
      }
      break;
    }
    cfg.add(32).writeU64(n); cfg.add(56).writeU64(nr);
    resumo = n + ' linha(s)';
    if (resumo !== ultimo) { ultimo = resumo; log('atualizado: ' + resumo + ' | PS vivos=' + vivos.length); }
  } catch (e) { log('erro atualizar: ' + e); }
}
setTimeout(passoHud, 3000);
})();
