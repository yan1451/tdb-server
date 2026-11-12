// replicacao_otimizada.js (2026-11-07) - SUBSTITUI os 3 scripts de replicacao do host/ (replicacao.js, replicacao_donos.js e
// replicacao_distancia.js v3), com o mesmo comportamento e duas otimizacoes:
//
//  1) FREQUENCIA (algoritmo): cada ator e replicado no ritmo do seu AActor::NetUpdateFrequency (+0x170), como o motor original faz,
//     em vez de "todo ator perto a cada 2 quadros". Ex.: Zombie_C tem 5/s (antes ~20/s). Piso de FREQ_MIN (4/s) para mudancas de
//     estado (portas, PlayerState com 1/s) nao demorarem mais que 250 ms - o motor tem ForceNetUpdate, que aqui nao enxergamos.
//     Ator novo para uma conexao (canal ainda nao aberto) passa na hora, sem esperar o ritmo.
//     PRIORIDADE: quando a lista "perto" de uma conexao enche (MAX_PERTO), entra o ator mais perto e sai o mais longe (com fechamento).
//
//  2) LACO EM C (CModule do Frida, compilado na hora pelo TinyCC): o gancho do TickFlush e nativo (onEnter em C); por quadro nao ha
//     nenhuma passagem pelo JS. O JS so prepara (acha driver, mundo, offsets), registra eventos raros (canal aberto/fechado) e
//     escreve as estatisticas a cada 60 s - inclusive QUANTO TEMPO O GANCHO GASTA POR QUADRO (linha "[otim]").
//
// Seguranca: em C um ponteiro ruim derruba o jogo (no JS era excecao capturada). Todo ator guardado entre quadros e validado na
// GObjects antes do uso (InternalIndex +0xC -> FUObjectItem.Object == ator e sem flags Garbage/Unreachable/PendingKill).
// O JS testa essa validacao na partida e a desliga (com aviso) se o layout nao bater.
//
// O que cada parte do antigo virou:
//   replicacao.js        -> "essenciais" (PC, Pawn, PlayerState, GameState por quadro) + "extras" (bAlwaysRelevant, a cada CAD_EXTRAS)
//   replicacao_donos.js  -> "donos" (Owner ate 4 niveis = PC/pawn da conexao; caminho rapido pelos Children a cada CAD_FILHOS)
//   replicacao_distancia -> "perto" (distancia <= NetCull; sai a > 1,2x NetCull; fecha o canal depois de GRACA_MS, exceto portas/
//                           teleportes; nunca fecha ator do proprio jogador)
// Uma varredura incremental dos niveis (LOTE_VARR atores/quadro) alimenta as tres listas; pausa de PAUSA quadros entre varreduras.
// Enderecos: os mesmos dos scripts antigos (verificados no Ghidra em 05-06/11). Offsets novos: SDK do Dumper-7 (Engine_classes.hpp).
(function () {
'use strict';
const TESTE = (typeof TDB_TESTE !== 'undefined');

// ---------- variaveis compartilhadas C <-> JS (arrays de int64; nomes viram #define no C) ----------
const VARS = ['PRONTO', 'DRV', 'WORLD', 'OFFACT', 'GOBJ', 'QPF', 'DEADMASK', 'VIVO_ON', 'GATING', 'FREQMIN100',
  'CAD_EXTRAS', 'CAD_REPL', 'CAD_FILHOS', 'PAUSA', 'LOTE_VARR', 'LOTE_DIST', 'MAXPERTO', 'GRACA_MS',
  'FRAME', 'NOW', 'NCAND', 'NEXTRA', 'NCANDNOVO', 'NEXTRANOVO', 'IDIST', 'NPEND',
  'SC_ATIVO', 'SC_NIVEL', 'SC_IDX', 'SC_TOTAL', 'SC_T0', 'SC_FIM', 'SC_FEITAS', 'TABN', 'TABTOMB', 'PASSO',
  'NACORD', 'MAXNOVOS', 'DORM_MS'];
const STATS = ['QUADROS', 'TEMPO', 'TEMPO_MAX', 'REPL', 'PULADOS', 'CANAIS', 'FECHADOS', 'DESPEJOS', 'SEMNIVEL', 'ERRO_CRIAR',
  'TAB_CHEIA', 'PEND_CHEIA', 'SCAN_TOTAL', 'SCAN_TICKS', 'REPL_ESS', 'REPL_EXTRA', 'REPL_DONO', 'REPL_DIST',
  'ACORDADOS', 'DORM_POUPADOS', 'NOVOS_ADIADOS', 'ACORD_CHEIA'];
const V = {}, S = {};
VARS.forEach((n, i) => { V[n] = i; }); STATS.forEach((n, i) => { S[n] = i; });
const EV = { ABERTO: 1, REPL1: 2, FECHADO: 3, SCAN: 4, FILHOS: 5, DONOS: 6 };
const LISTA = ['PC', 'Pawn', 'PlayerState', 'GameState', 'extra', 'dono', 'distancia'];
// EXTRA era 150 (= limite do host/): os baus de loot (MPMainContainerBox, bAlwaysRelevant) passavam de 150 e ficavam sem canal (07/11)
const TAM = { TAB: 32768, SLOTS: 16, PERTO: 256, DONO: 64, CAND: 20000, EXTRA: 32768,   /* EXTRA: 07/11 na VPS os sempre relevantes passaram de 7.600 com o mapa carregado */ PEND: 4096, CLS: 1024, ACORD: 512 };

function fonteC() {
  const defs = VARS.map((n, i) => '#define V_' + n + ' ' + i).concat(STATS.map((n, i) => '#define S_' + n + ' ' + i)).join('\n');
  return defs + '\n' + `
#include <gum/guminterceptor.h>
typedef unsigned long long u64;
typedef long long i64;
typedef unsigned short u16;
typedef unsigned char u8;

#define TAB ${TAM.TAB}
#define TABMASK (TAB - 1)
#define MAXSLOT ${TAM.SLOTS}
#define MAXPERTO ${TAM.PERTO}
#define MAXDONO ${TAM.DONO}
#define MAXCAND ${TAM.CAND}
#define MAXEXTRA ${TAM.EXTRA}
#define MAXPEND ${TAM.PEND}
#define NCLS ${TAM.CLS}
#define MAXACORD ${TAM.ACORD}
#define F_DUE 1
#define F_LOG 2
#define L_PC 0
#define L_PAWN 1
#define L_PS 2
#define L_GS 3
#define L_EXTRA 4
#define L_DONO 5
#define L_DIST 6
#define EV_ABERTO ${EV.ABERTO}
#define EV_REPL1 ${EV.REPL1}
#define EV_FECHADO ${EV.FECHADO}
#define EV_SCAN ${EV.SCAN}
#define EV_FILHOS ${EV.FILHOS}
#define EV_DONOS ${EV.DONOS}
#define VAZIO ((void *) 0)
#define TUMULO ((void *) 1)

/* 40 bytes (o JS confere com tdb_ent_size). sujo = conexoes que precisam receber o ator de novo (acordado pelo jogo) */
typedef struct { void * a; i64 next; int frame; u16 flags; u16 repl; u16 perto; u16 pend; u16 dono; u16 aber; u16 sujo; u16 pad; int pad2; } Ent;

extern i64 v[128];
extern i64 st[64];
extern Ent tab[TAB];
extern Ent tab2[TAB];
extern void * cand[MAXCAND];
extern void * cand_novo[MAXCAND];
extern void * extras[MAXEXTRA];
extern void * extras_novo[MAXEXTRA];
extern void * slot_conn[MAXSLOT];
extern void * slot_pc[MAXSLOT];
extern void * slot_pawn[MAXSLOT];
extern double slot_loc[MAXSLOT * 3];
extern int slot_ok[MAXSLOT];
extern void * perto[MAXSLOT * MAXPERTO];
extern int perto_n[MAXSLOT];
extern double perto_far[MAXSLOT];
extern int perto_faridx[MAXSLOT];
extern void * donos[MAXSLOT * MAXDONO];
extern int donos_n[MAXSLOT];
extern void * donos_novo[MAXSLOT * MAXDONO];
extern int donos_novo_n[MAXSLOT];
extern void * pend_a[MAXPEND];
extern void * pend_c[MAXPEND];
extern int pend_s[MAXPEND];
extern i64 pend_t[MAXPEND];
extern void * cls_k[NCLS];
extern int cls_v[NCLS];
extern int novos_n[MAXSLOT];
extern int ext_cur[MAXSLOT];
extern void * acord[MAXACORD];
extern u8 weakbuf[16];
extern u8 nome_actor[8];

extern void tdb_evento (int tipo, int lista, void * a, i64 x);
extern int tdb_classificar (void * cls);
extern void tdb_pre (void * a, void * d);
extern void * tdb_weak (void * out, void * a);
extern void * tdb_find (void * conn, void * weak);
extern void * tdb_create (void * conn, void * nome, unsigned int flags, int idx);
extern void tdb_setactor (void * ch, void * a, unsigned int flags);
extern u8 tdb_ready (void * ch);
extern void tdb_initcomps (void * a);
extern i64 tdb_repl (void * ch);
extern int tdb_qpc (i64 * out);

typedef u8 (* FIsLvl) (void *, void *, void *);
typedef i64 (* FClose) (void *, u8);

static void * rdp (void * p, int o) { return *(void **) ((char *) p + o); }
static int rd32 (void * p, int o) { return *(int *) ((char *) p + o); }
static u8 rd8 (void * p, int o) { return *((u8 *) p + o); }

int tdb_ent_size (void) { return (int) sizeof (Ent); }

static int vivo (void * o)
{
  char * g; char ** chunks; char * item; int idx, num, nch;
  if ((u64) o < 0x10000) return 0;
  if (!v[V_VIVO_ON]) return 1;
  g = (char *) v[V_GOBJ];
  idx = rd32 (o, 0xC); num = *(int *) (g + 0x14); nch = *(int *) (g + 0x1C);
  if (idx < 0 || idx >= num || (idx >> 16) >= nch) return 0;
  chunks = *(char ***) g;
  if (chunks[idx >> 16] == 0) return 0;
  item = chunks[idx >> 16] + (idx & 0xFFFF) * 0x18;
  if (*(void **) item != o) return 0;
  if (*(int *) (item + 8) & (int) v[V_DEADMASK]) return 0;
  return 1;
}

static int replicavel (void * a)
{
  if (rd8 (a, 0x5d) & 1) return 0;            /* pending kill / tear off */
  if (((rd8 (a, 0x5b) >> 3) & 1) == 0) return 0;  /* bReplicates */
  return rd8 (a, 0x68) != 0;                  /* RemoteRole != None */
}

static int loc (void * a, double * out)
{
  double * p; void * r = rdp (a, 0x198); int i;
  if (r == 0) return 0;
  /* 07/11: ator anexado (arma na mao, mochila...) tem RelativeLocation relativa ao encaixe (~0,0,0): sobe pelo AttachParent
     (USceneComponent +0xB0) ate o topo, que e posicao de mundo (para a arma, a capsula do pawn). Sem isso a arma "ficava" na
     origem do mapa e nunca ganhava canal para os outros jogadores (so para o dono, pela lista de donos). */
  for (i = 0; i < 8; i++) { void * par = rdp (r, 0xb0); if (par == 0) break; r = par; }
  p = (double *) ((char *) r + 0x128);
  out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
  return 1;
}

static double dist2 (double * p, int s)
{
  double dx = p[0] - slot_loc[s * 3], dy = p[1] - slot_loc[s * 3 + 1], dz = p[2] - slot_loc[s * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/* ---------- tabela ator -> agenda/membros (enderecamento aberto, tumulos) ---------- */
static unsigned int hash_ptr (void * a) { return (unsigned int) ((((u64) a >> 4) * 0x9E3779B97F4A7C15ULL) >> 49) & TABMASK; }

static void ent_zera (Ent * e, void * a)
{
  e->a = a; e->next = 0; e->frame = -1; e->flags = 0; e->repl = 0; e->perto = 0; e->pend = 0; e->dono = 0; e->aber = 0; e->sujo = 0;
}

static Ent * ent_get (void * a, int criar)
{
  unsigned int i = hash_ptr (a); int k; Ent * tum = 0; Ent * e;
  for (k = 0; k < 64; k++) {
    e = &tab[(i + k) & TABMASK];
    if (e->a == a) return e;
    if (e->a == VAZIO) {
      if (!criar) return 0;
      if (tum) { e = tum; v[V_TABTOMB]--; }
      ent_zera (e, a); v[V_TABN]++;
      return e;
    }
    if (e->a == TUMULO && tum == 0) tum = e;
  }
  if (criar && tum) { ent_zera (tum, a); v[V_TABTOMB]--; v[V_TABN]++; return tum; }
  if (criar) st[S_TAB_CHEIA]++;
  return 0;
}

static void reconstruir_tab (void)
{
  int i, k; unsigned int h;
  for (i = 0; i < TAB; i++) tab2[i].a = VAZIO;
  for (i = 0; i < TAB; i++) {
    if ((u64) tab[i].a <= 1) continue;
    h = hash_ptr (tab[i].a);
    for (k = 0; k < TAB; k++) { Ent * d = &tab2[(h + k) & TABMASK]; if (d->a == VAZIO) { *d = tab[i]; break; } }
  }
  for (i = 0; i < TAB; i++) tab[i] = tab2[i];
  v[V_TABTOMB] = 0;
}

static void varrer_tab (void)
{
  int i;
  for (i = 0; i < TAB; i++) {
    Ent * e = &tab[i];
    if ((u64) e->a <= 1) continue;
    if (!vivo (e->a)) { e->a = TUMULO; v[V_TABN]--; v[V_TABTOMB]++; }
  }
  if (v[V_TABTOMB] > TAB / 8) reconstruir_tab ();
}

static void limpar_bit (int s)
{
  int i; u16 m = (u16) ~(1 << s);
  for (i = 0; i < TAB; i++) {
    Ent * e = &tab[i];
    if ((u64) e->a <= 1) continue;
    e->perto &= m; e->pend &= m; e->dono &= m; e->aber &= m; e->repl &= m; e->sujo &= m;
  }
}

/* ---------- classes: bit0 = preservada (porta/teleporte: canal nunca fecha por distancia) ---------- */
static int cls_flags (void * cls)
{
  unsigned int i = (unsigned int) (((u64) cls >> 4) & (NCLS - 1)); int k, f;
  for (k = 0; k < NCLS; k++) {
    int j = (i + k) & (NCLS - 1);
    if (cls_k[j] == cls) return cls_v[j];
    if (cls_k[j] == 0) { f = tdb_classificar (cls); cls_k[j] = cls; cls_v[j] = f; return f; }
  }
  return tdb_classificar (cls);
}
static int preservado (void * a) { return cls_flags (rdp (a, 0x10)) & 1; }

/* ---------- dormencia (DORM_DormantAll = 2, DORM_Initial = 4): o motor so replica de novo depois de FlushNetDormancy ---------- */
static int dormente (void * a) { u8 d = rd8 (a, 0x151); return d == 2 || d == 4; }

/* chamado pelos ganchos de AActor::FlushNetDormancy / ForceNetUpdate (thread do jogo): reenvia para quem ja tem o canal */
void tdb_acordar (void * a)
{
  Ent * e;
  if ((u64) a < 0x10000) return;
  e = ent_get (a, 0);
  if (e == 0 || e->aber == 0) return;                /* ninguem tem canal: vai receber tudo quando o canal abrir */
  e->sujo |= e->aber;
  st[S_ACORDADOS]++;
  if (v[V_NACORD] < MAXACORD) acord[v[V_NACORD]++] = a; else st[S_ACORD_CHEIA]++;
}

/* ---------- agenda por frequencia ---------- */
static void tocar (Ent * e, void * a)
{
  int fr = (int) v[V_FRAME];
  float f, fmin; double iv;
  if (e->frame == fr) return;
  e->frame = fr; e->repl = 0;
  if (!v[V_GATING] || v[V_NOW] >= e->next) {
    f = *(float *) ((char *) a + 0x170);
    fmin = (float) v[V_FREQMIN100] / 100.0f;
    if (!(f >= fmin)) f = fmin;                       /* tambem trata NaN e 0 */
    iv = (double) v[V_QPF] / (double) f;
    if (dormente (a)) iv = (double) v[V_QPF] * (double) v[V_DORM_MS] / 1000.0;   /* dormente: so releitura de seguranca */
    e->flags |= F_DUE;
    /* avanca a partir do horario marcado (sem acumular o atraso do quadro); no 1o envio espalha a fase (ate 1 intervalo) */
    if (e->next == 0) e->next = v[V_NOW] + (dormente (a) ? (i64) iv : 0) + (i64) (iv * (double) (int) ((((u64) a) >> 4) & 63) / 64.0);
    else { e->next += (i64) iv; if (e->next < v[V_NOW] - (i64) iv) e->next = v[V_NOW]; }
  } else e->flags &= (u16) ~F_DUE;
}

/* ---------- replicar um ator para a conexao do slot s ---------- */
static void replicar (int s, void * a, int lista, Ent * e)
{
  void * conn; void * ch; i64 bits; int bit = 1 << s;
  if ((u64) a < 0x10000 || !vivo (a) || !replicavel (a)) return;
  if (e == 0) e = ent_get (a, 1);
  if (e) {
    tocar (e, a);
    if (e->repl & bit) return;                                     /* ja foi neste quadro (duas listas) */
    if (!(e->flags & F_DUE) && (e->aber & bit) && !(e->sujo & bit)) { if (dormente (a)) st[S_DORM_POUPADOS]++; else st[S_PULADOS]++; return; }
  }
  conn = slot_conn[s];
  tdb_pre (a, (void *) v[V_DRV]);
  tdb_weak (weakbuf, a);
  ch = tdb_find (conn, weakbuf);
  if (ch == 0) {
    FIsLvl ok = *(FIsLvl *) (*(char **) v[V_DRV] + 0x438);
    if (novos_n[s] >= v[V_MAXNOVOS]) { st[S_NOVOS_ADIADOS]++; return; }   /* freio: N canais novos por conexao por quadro */
    if (!ok ((void *) v[V_DRV], a, conn)) { st[S_SEMNIVEL]++; return; }
    ch = tdb_create (conn, nome_actor, 2, -1);
    if (ch == 0) { st[S_ERRO_CRIAR]++; return; }
    tdb_setactor (ch, a, 0);
    novos_n[s]++;
    st[S_CANAIS]++;
    tdb_evento (EV_ABERTO, lista, a, (i64) ch);
  }
  if (e) { e->aber |= (u16) bit; e->repl |= (u16) bit; e->sujo &= (u16) ~bit; }
  if (rd8 (ch, 0x30) & 2) return;                                  /* canal fechando */
  if (!tdb_ready (ch)) tdb_initcomps (a);
  bits = tdb_repl (ch);
  st[S_REPL]++;
  if (lista <= L_GS) st[S_REPL_ESS]++; else if (lista == L_EXTRA) st[S_REPL_EXTRA]++; else if (lista == L_DONO) st[S_REPL_DONO]++; else st[S_REPL_DIST]++;
  if (e && bits > 0 && lista != L_DIST && !(e->flags & F_LOG)) { e->flags |= F_LOG; tdb_evento (EV_REPL1, lista, a, bits); }
}

/* ---------- fechar canal (saiu do alcance) ---------- */
static void fechar (int s, void * a, Ent * e)
{
  void * dono = rdp (a, 0x140); void * ch; FClose fc;
  if (dono && (dono == slot_pawn[s] || dono == slot_pc[s])) return;
  tdb_weak (weakbuf, a);
  ch = tdb_find (slot_conn[s], weakbuf);
  if (ch == 0 || (rd8 (ch, 0x30) & 2)) return;
  fc = *(FClose *) (*(char **) ch + 0x2c8);
  fc (ch, 3);                                                      /* EChannelCloseReason::Relevancy */
  e->aber &= (u16) ~(1 << s);
  st[S_FECHADOS]++;
  tdb_evento (EV_FECHADO, L_DIST, a, 0);
}

static void agendar_fechar (int s, void * a, Ent * e)
{
  int bit = 1 << s; int i;
  if (preservado (a)) return;
  if (e->pend & bit) return;
  if (v[V_NPEND] >= MAXPEND) { st[S_PEND_CHEIA]++; fechar (s, a, e); return; }
  i = (int) v[V_NPEND]++;
  pend_a[i] = a; pend_c[i] = slot_conn[s]; pend_s[i] = s;
  pend_t[i] = v[V_NOW] + v[V_QPF] * v[V_GRACA_MS] / 1000;
  e->pend |= (u16) bit;
}

static void processar_pend (void)
{
  int i, j = 0, n = (int) v[V_NPEND];
  for (i = 0; i < n; i++) {
    void * a = pend_a[i]; int s = pend_s[i]; int bit = 1 << s; Ent * e = ent_get (a, 0);
    if (e == 0 || !(e->pend & bit) || slot_conn[s] != pend_c[i]) continue;
    if (v[V_NOW] < pend_t[i]) { pend_a[j] = a; pend_c[j] = pend_c[i]; pend_s[j] = s; pend_t[j] = pend_t[i]; j++; continue; }
    e->pend &= (u16) ~bit;
    if (!(e->perto & bit) && vivo (a)) fechar (s, a, e);
  }
  v[V_NPEND] = j;
}

/* ---------- conexoes -> slots ---------- */
static void liberar_slot (int s)
{
  limpar_bit (s);
  slot_conn[s] = 0; slot_pc[s] = 0; slot_pawn[s] = 0; slot_ok[s] = 0;
  perto_n[s] = 0; perto_faridx[s] = -1; donos_n[s] = 0; donos_novo_n[s] = 0; ext_cur[s] = 0;
}

static void atualizar_slots (void)
{
  char * drv = (char *) v[V_DRV];
  void ** conns = *(void ***) (drv + 0xa0); int nc = *(int *) (drv + 0xa8);
  int visto[MAXSLOT]; int i, s, livre;
  for (s = 0; s < MAXSLOT; s++) visto[s] = 0;
  for (i = 0; i < nc && i < MAXSLOT; i++) {
    void * c = conns[i]; void * pc;
    if (c == 0) continue;
    pc = rdp (c, 0x30);
    if (pc == 0) continue;                                         /* ainda sem Join */
    s = -1; livre = -1;
    { int k; for (k = 0; k < MAXSLOT; k++) { if (slot_conn[k] == c) { s = k; break; } if (slot_conn[k] == 0 && livre < 0) livre = k; } }
    if (s < 0) { if (livre < 0) continue; s = livre; liberar_slot (s); slot_conn[s] = c; }
    visto[s] = 1;
    slot_pc[s] = pc;
    slot_pawn[s] = rdp (pc, 0x2d0);
    slot_ok[s] = slot_pawn[s] != 0 && vivo (slot_pawn[s]) && loc (slot_pawn[s], &slot_loc[s * 3]);
    if (rdp (c, 0x90) == 0) *(void **) ((char *) c + 0x90) = slot_pawn[s] ? slot_pawn[s] : pc;   /* ViewTarget */
  }
  for (s = 0; s < MAXSLOT; s++) if (slot_conn[s] && !visto[s]) liberar_slot (s);
}

/* ---------- varredura incremental dos niveis ---------- */
static int raiz_slot (void * o)
{
  int s;
  for (s = 0; s < MAXSLOT; s++) if (slot_conn[s] && (o == slot_pc[s] || (slot_pawn[s] && o == slot_pawn[s]))) return s;
  return -1;
}

static void scan_iniciar (void)
{
  int s;
  v[V_SC_ATIVO] = 1; v[V_SC_NIVEL] = 0; v[V_SC_IDX] = 0; v[V_SC_TOTAL] = 0; v[V_SC_T0] = v[V_NOW];
  v[V_NCANDNOVO] = 0; v[V_NEXTRANOVO] = 0;
  for (s = 0; s < MAXSLOT; s++) donos_novo_n[s] = 0;
}

static void scan_ator (char * a)
{
  int rep = replicavel (a); u8 f58 = (u8) a[0x58];
  if (rep) {
    void * o = rdp (a, 0x140); int d, s;
    for (d = 0; d < 4 && o; d++) {
      s = raiz_slot (o);
      if (s >= 0) { if (donos_novo_n[s] < MAXDONO) donos_novo[s * MAXDONO + donos_novo_n[s]++] = a; break; }
      o = rdp (o, 0x140);
    }
  }
  if (f58 & 8) { if (rep && v[V_NEXTRANOVO] < MAXEXTRA) extras_novo[v[V_NEXTRANOVO]++] = a; return; }   /* bAlwaysRelevant */
  if (f58 & 4) return;                                                                              /* bOnlyRelevantToOwner */
  if (!rep || rdp (a, 0x198) == 0) return;
  if (v[V_NCANDNOVO] < MAXCAND) cand_novo[v[V_NCANDNOVO]++] = a;
}

static void scan_fim (void)
{
  int i, s, n;
  for (i = 0; i < (int) v[V_NCANDNOVO]; i++) cand[i] = cand_novo[i];
  v[V_NCAND] = v[V_NCANDNOVO]; v[V_IDIST] = 0;
  for (i = 0; i < (int) v[V_NEXTRANOVO]; i++) extras[i] = extras_novo[i];
  v[V_NEXTRA] = v[V_NEXTRANOVO];
  for (s = 0; s < MAXSLOT; s++) {
    int bit = 1 << s, antes;
    if (!slot_conn[s]) continue;
    antes = donos_n[s];
    for (i = 0; i < donos_n[s]; i++) { Ent * e = ent_get (donos[s * MAXDONO + i], 0); if (e) e->dono &= (u16) ~bit; }
    n = donos_novo_n[s];
    for (i = 0; i < n; i++) { void * a = donos_novo[s * MAXDONO + i]; Ent * e = ent_get (a, 1); if (e) e->dono |= (u16) bit; donos[s * MAXDONO + i] = a; }
    donos_n[s] = n; donos_novo_n[s] = 0;
    if (n != antes) tdb_evento (EV_DONOS, s, slot_conn[s], n);
  }
  st[S_SCAN_TOTAL] = v[V_SC_TOTAL]; st[S_SCAN_TICKS] = v[V_NOW] - v[V_SC_T0];
  tdb_evento (EV_SCAN, (int) v[V_NCAND], 0, v[V_NEXTRA]);
  v[V_SC_ATIVO] = 0; v[V_SC_FIM] = v[V_FRAME]; v[V_SC_FEITAS]++;
}

static void scan_passo (void)
{
  char * w = (char *) v[V_WORLD];
  void ** lv = *(void ***) (w + 0x170); int nl = *(int *) (w + 0x178);
  int off = (int) v[V_OFFACT]; int feitos = 0;
  while (v[V_SC_NIVEL] < nl && v[V_SC_NIVEL] < 8192 && feitos < v[V_LOTE_VARR]) {
    char * L = (char *) lv[v[V_SC_NIVEL]]; void ** arr; int n; char * a;
    if (L == 0) { v[V_SC_NIVEL]++; v[V_SC_IDX] = 0; continue; }
    arr = *(void ***) (L + off); n = *(int *) (L + off + 8);
    if (arr == 0 || v[V_SC_IDX] >= n || v[V_SC_IDX] >= 200000) { v[V_SC_NIVEL]++; v[V_SC_IDX] = 0; continue; }
    a = (char *) arr[v[V_SC_IDX]++]; feitos++; v[V_SC_TOTAL]++;
    if ((u64) a >= 0x10000) scan_ator (a);
  }
  if (v[V_SC_NIVEL] >= nl || v[V_SC_NIVEL] >= 8192) scan_fim ();
}

/* ---------- distancia: entradas na lista "perto" ---------- */
static void inserir_perto (int s, void * a, double d2)
{
  int cap = (int) v[V_MAXPERTO]; int bit = 1 << s; Ent * e;
  if (cap > MAXPERTO) cap = MAXPERTO;
  if (perto_n[s] >= cap) {
    int fi = perto_faridx[s]; void * b; Ent * eb;
    if (fi < 0 || fi >= perto_n[s] || d2 >= perto_far[s]) return;      /* cheio e este nao e mais perto que o mais longe */
    e = ent_get (a, 1); if (e == 0) return;
    b = perto[s * MAXPERTO + fi]; eb = ent_get (b, 0);
    if (eb) { eb->perto &= (u16) ~bit; agendar_fechar (s, b, eb); }
    perto[s * MAXPERTO + fi] = a; perto_faridx[s] = -1; st[S_DESPEJOS]++;
  } else {
    e = ent_get (a, 1); if (e == 0) return;
    perto[s * MAXPERTO + perto_n[s]++] = a;
  }
  e->perto |= (u16) bit; e->pend &= (u16) ~bit;
}

static void dist_passo (void)
{
  int n, s, nc = (int) v[V_NCAND]; double p[3];
  if (nc <= 0) return;
  for (n = 0; n < v[V_LOTE_DIST] && n < nc; n++) {
    char * a; double cs;
    if (v[V_IDIST] >= nc) v[V_IDIST] = 0;
    a = (char *) cand[v[V_IDIST]++];
    if (!vivo (a) || !replicavel (a) || !loc (a, p)) continue;
    cs = (double) *(float *) (a + 0x168);
    for (s = 0; s < MAXSLOT; s++) {
      double d2; Ent * e;
      if (!slot_conn[s] || !slot_ok[s]) continue;
      d2 = dist2 (p, s);
      if (d2 > cs) continue;
      e = ent_get (a, 0);
      if (e && (e->perto & (1 << s))) continue;
      inserir_perto (s, a, d2);
    }
  }
}

/* ---------- passes de replicacao das listas ---------- */
static void passar_perto (int s)
{
  int i, j = 0, n = perto_n[s], bit = 1 << s, fi = -1; double far = -1.0, p[3];
  for (i = 0; i < n; i++) {
    char * a = (char *) perto[s * MAXPERTO + i]; Ent * e = ent_get (a, 0);
    if (e == 0 || !(e->perto & bit)) continue;
    if (!vivo (a) || !replicavel (a)) { e->perto &= (u16) ~bit; continue; }
    if (slot_ok[s] && loc (a, p)) {
      double d2 = dist2 (p, s), cs = (double) *(float *) (a + 0x168);
      if (d2 > cs * 1.44) { e->perto &= (u16) ~bit; agendar_fechar (s, a, e); continue; }   /* saiu: 1,2x NetCull */
      if (d2 > far) { far = d2; fi = j; }
    }
    perto[s * MAXPERTO + j++] = a;
    replicar (s, a, L_DIST, e);
  }
  perto_n[s] = j; perto_far[s] = far; perto_faridx[s] = fi;
}

static void passar_donos (int s)
{
  int i, j = 0, n = donos_n[s], bit = 1 << s;
  for (i = 0; i < n; i++) {
    void * a = donos[s * MAXDONO + i]; Ent * e = ent_get (a, 0);
    if (!vivo (a)) { if (e) e->dono &= (u16) ~bit; continue; }
    donos[s * MAXDONO + j++] = a;
    replicar (s, a, L_DONO, e);
  }
  donos_n[s] = j;
}

/* caminho rapido pelos filhos (AActor::Children +0x188, mantido pelo SetOwner): arma/equipamento chegam em ~CAD_FILHOS quadros */
static void filhos (int s)
{
  void * fila[128]; void * prox[128];   /* <4 KB de pilha (sem __chkstk no TinyCC) */ int nf = 0, np, d, k, j, add = 0, bit = 1 << s;
  fila[nf++] = slot_pc[s]; if (slot_pawn[s]) fila[nf++] = slot_pawn[s];
  for (d = 0; d < 4 && nf > 0; d++) {
    np = 0;
    for (k = 0; k < nf; k++) {
      void * o = fila[k]; void ** arr; int n;
      if (!vivo (o)) continue;
      arr = (void **) rdp (o, 0x188); n = rd32 (o, 0x190);
      if (arr == 0) continue;
      for (j = 0; j < n && j < 64; j++) {
        void * a = arr[j]; Ent * e;
        if ((u64) a < 0x10000) continue;
        if (np < 128) prox[np++] = a;
        e = ent_get (a, 0);
        if (e && (e->dono & bit)) continue;
        if (replicavel (a) && donos_n[s] < MAXDONO) {
          e = ent_get (a, 1); if (e) e->dono |= (u16) bit;
          donos[s * MAXDONO + donos_n[s]++] = a; add++;
        }
      }
    }
    for (k = 0; k < np; k++) fila[k] = prox[k];
    nf = np;
  }
  if (add) tdb_evento (EV_FILHOS, s, slot_conn[s], add);
}

/* abre, a cada quadro, os canais que faltam dos sempre relevantes (cursor por conexao, ate o freio MAXNOVOS);
   o reenvio dos ja abertos fica no laco normal a cada CAD_EXTRAS quadros */
static void abrir_extras (int s)
{
  int n = (int) v[V_NEXTRA], k, bit = 1 << s;
  if (n <= 0) return;
  for (k = 0; k < 1024 && k < n && novos_n[s] < v[V_MAXNOVOS]; k++) {
    void * a; Ent * e;
    if (ext_cur[s] >= n) ext_cur[s] = 0;
    a = extras[ext_cur[s]++];
    e = ent_get (a, 0);
    if (e && (e->aber & bit)) continue;
    replicar (s, a, L_EXTRA, e);
  }
}

/* ---------- um quadro ---------- */
static void tick (void)
{
  int s, i; void * gs; i64 fr;
  fr = ++v[V_FRAME];
  for (s = 0; s < MAXSLOT; s++) novos_n[s] = 0;
  *(int *) ((char *) v[V_DRV] + 0x448) += 1;                     /* ServerReplicateActors faz ReplicationFrame++ */
  v[V_PASSO] = 1; atualizar_slots ();
  v[V_PASSO] = 2;
  if (!v[V_SC_ATIVO] && (v[V_SC_FEITAS] == 0 || fr - v[V_SC_FIM] >= v[V_PAUSA])) scan_iniciar ();
  if (v[V_SC_ATIVO]) scan_passo ();
  v[V_PASSO] = 3;
  gs = rdp ((void *) v[V_WORLD], 0x158);
  for (s = 0; s < MAXSLOT; s++) {
    void * pc;
    if (!slot_conn[s]) continue;
    pc = slot_pc[s];
    replicar (s, pc, L_PC, 0);
    if (slot_pawn[s]) replicar (s, slot_pawn[s], L_PAWN, 0);
    replicar (s, rdp (pc, 0x298), L_PS, 0);
    if (gs) replicar (s, gs, L_GS, 0);
    if (fr % v[V_CAD_EXTRAS] == 0) for (i = 0; i < (int) v[V_NEXTRA]; i++) replicar (s, extras[i], L_EXTRA, 0);
    else abrir_extras (s);
  }
  if (v[V_NACORD] > 0) {                                          /* acordados pelo jogo: reenvia ja neste quadro */
    for (i = 0; i < (int) v[V_NACORD]; i++) {
      Ent * e = ent_get (acord[i], 0);
      if (e == 0) continue;
      for (s = 0; s < MAXSLOT; s++) if (slot_conn[s] && (e->sujo & (1 << s))) replicar (s, acord[i], L_EXTRA, e);
    }
    v[V_NACORD] = 0;
  }
  v[V_PASSO] = 4; dist_passo ();
  v[V_PASSO] = 5; processar_pend ();
  v[V_PASSO] = 6;
  if (fr % v[V_CAD_FILHOS] == 0) for (s = 0; s < MAXSLOT; s++) if (slot_conn[s]) filhos (s);
  v[V_PASSO] = 7;
  if (fr % v[V_CAD_REPL] == 0) for (s = 0; s < MAXSLOT; s++) if (slot_conn[s]) { v[V_PASSO] = 8; passar_donos (s); v[V_PASSO] = 9; passar_perto (s); }
  v[V_PASSO] = 10;
  if (fr % 600 == 0) varrer_tab ();
  v[V_PASSO] = 0;
}

void onEnter (GumInvocationContext * ic)
{
  i64 t0, t1, dt;
  if (!v[V_PRONTO]) return;
  if (gum_invocation_context_get_nth_argument (ic, 0) != (void *) v[V_DRV]) return;
  tdb_qpc (&t0);
  v[V_NOW] = t0;
  tick ();
  tdb_qpc (&t1);
  dt = t1 - t0;
  st[S_QUADROS]++; st[S_TEMPO] += dt;
  if (dt > st[S_TEMPO_MAX]) st[S_TEMPO_MAX] = dt;
}

/* para o teste fora do jogo: funcoes isoladas */
int tdb_dbg_vivo (void * o) { return vivo (o); }
int tdb_dbg_loc (void * o) { double p[3]; return loc (o, p); }
int tdb_dbg_rep (void * o) { return replicavel (o); }
i64 tdb_dbg_v (int i) { return v[i]; }
/* para o teste fora do jogo (host_otimizado/testes): um quadro com o relogio dado */
void tdb_tick_teste (i64 agora) { v[V_NOW] = agora; tick (); }

void tdb_init (void)
{
  int i;
  for (i = 0; i < TAB; i++) { tab[i].a = VAZIO; tab2[i].a = VAZIO; }
  for (i = 0; i < MAXSLOT; i++) { novos_n[i] = 0; ext_cur[i] = 0; slot_conn[i] = 0; slot_pc[i] = 0; slot_pawn[i] = 0; slot_ok[i] = 0; perto_n[i] = 0; perto_faridx[i] = -1; perto_far[i] = 0; donos_n[i] = 0; donos_novo_n[i] = 0; }
  for (i = 0; i < NCLS; i++) { cls_k[i] = 0; cls_v[i] = 0; }
  for (i = 0; i < 128; i++) v[i] = 0;
  for (i = 0; i < 64; i++) st[i] = 0;
}
`;
}

function alocar() {
  const m = {};
  const tam = { v: 128 * 8, st: 64 * 8, tab: TAM.TAB * 40, tab2: TAM.TAB * 40, novos_n: TAM.SLOTS * 4, ext_cur: TAM.SLOTS * 4, acord: TAM.ACORD * 8, cand: TAM.CAND * 8, cand_novo: TAM.CAND * 8,
    extras: TAM.EXTRA * 8, extras_novo: TAM.EXTRA * 8, slot_conn: TAM.SLOTS * 8, slot_pc: TAM.SLOTS * 8, slot_pawn: TAM.SLOTS * 8,
    slot_loc: TAM.SLOTS * 3 * 8, slot_ok: TAM.SLOTS * 4, perto: TAM.SLOTS * TAM.PERTO * 8, perto_n: TAM.SLOTS * 4,
    perto_far: TAM.SLOTS * 8, perto_faridx: TAM.SLOTS * 4, donos: TAM.SLOTS * TAM.DONO * 8, donos_n: TAM.SLOTS * 4,
    donos_novo: TAM.SLOTS * TAM.DONO * 8, donos_novo_n: TAM.SLOTS * 4, pend_a: TAM.PEND * 8, pend_c: TAM.PEND * 8,
    pend_s: TAM.PEND * 4, pend_t: TAM.PEND * 8, cls_k: TAM.CLS * 8, cls_v: TAM.CLS * 4, weakbuf: 16, nome_actor: 8 };
  for (const k in tam) m[k] = Memory.alloc(tam[k]);
  return m;
}

// valores padrao (podem ser mudados por `var OTIM_*` injetada pelo runner)
function configurar(mem, qpf) {
  const w = (n, x) => mem.v.add(V[n] * 8).writeS64(x);
  w('QPF', qpf);
  w('DEADMASK', (1 << 21) | (1 << 28) | (1 << 29));   // Garbage | Unreachable | PendingKill (EInternalObjectFlags, UE 5.2)
  w('VIVO_ON', 1);
  w('GATING', (typeof OTIM_SEM_FREQUENCIA !== 'undefined' && OTIM_SEM_FREQUENCIA) ? 0 : 1);
  w('FREQMIN100', (typeof OTIM_FREQ_MIN !== 'undefined') ? Math.round(OTIM_FREQ_MIN * 100) : 400);
  w('CAD_EXTRAS', 10); w('CAD_REPL', 2); w('CAD_FILHOS', 10); w('PAUSA', 300);
  w('LOTE_VARR', 8000); w('LOTE_DIST', 2000); w('MAXPERTO', 250); w('GRACA_MS', 8000);
  w('MAXNOVOS', 32);      // canais novos por conexao por quadro (milhares de baus sempre relevantes nao abrem todos de uma vez)
  w('DORM_MS', 10000);    // ator dormente: releitura de seguranca a cada 10 s (alem de quando o jogo o acorda)
}

function montar(simbolos, mem) {
  const cm = new CModule(fonteC(), Object.assign({}, mem, simbolos));
  const tamEnt = new NativeFunction(cm.tdb_ent_size, 'int', [])();
  if (tamEnt !== 40) throw new Error('struct Ent com ' + tamEnt + ' bytes (esperado 40)');
  new NativeFunction(cm.tdb_init, 'void', [])();
  return cm;
}

if (TESTE) { globalThis.TDB_OTIM = { VARS, STATS, V, S, EV, LISTA, TAM, fonteC, alocar, configurar, montar }; return; }

// ======================================================= no jogo =======================================================
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: m }); }
const RVA = { fnamePool: 0x7c27980, gEngine: 0x7e20ea8, gObjects: 0x7ccda10, tickFlush: 0x42f3650, callPreReplication: 0x3d3beb0,
  makeWeak: 0x24382c0, findActorChannelRef: 0x4052f30, createChannelByName: 0x42d10a0, setChannelActor: 0x4033210,
  isActorReady: 0x40227a0, initReplicatedComponents: 0x3d70170, replicateActor: 0x402ec70 };
const PRESERVAR = /Teleport|Door|Gate|Exit/;

const pool = B.add(RVA.fnamePool);
function findFName(target) {
  for (let block = 0; block < 512; block++) {
    const bp = pool.add(0x10).add(block * 8).readPointer(); if (bp.isNull()) break;
    let units = 0;
    while (units < 65536) {
      const e = bp.add(units * 2), h = e.readU16(), wide = (h & 1) !== 0, len = h >>> 6;
      if (len <= 0 || len > 1024) break;
      if (len === target.length) { let s = null; try { s = wide ? e.add(2).readUtf16String(len) : e.add(2).readUtf8String(len); } catch (x) {} if (s === target) return ((block << 16) | units) >>> 0; }
      units += ((2 + len * (wide ? 2 : 1)) + 1) >> 1;
    }
  }
  return -1;
}
function fnameStr(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nomeObj(o) { try { return fnameStr(o.add(0x18).readU32()); } catch (x) { return '?'; } }
function classe(o) { try { return nomeObj(o.add(0x10).readPointer()); } catch (x) { return '?'; } }

const mem = alocar();
const k32 = Process.getModuleByName('kernel32.dll');
const qpfBuf = Memory.alloc(8);
new NativeFunction(k32.getExportByName('QueryPerformanceFrequency'), 'int', ['pointer'])(qpfBuf);
const QPF = qpfBuf.readS64().toNumber();
const rd = (arr, i) => arr.add(i * 8).readS64().toNumber();
const vget = n => rd(mem.v, V[n]);
const vset = (n, x) => { const p = mem.v.add(V[n] * 8); if (x instanceof NativePointer) p.writePointer(x); else p.writeS64(x); };

// ---- eventos raros vindos do C (na thread do jogo) ----
const abertosPorClasse = {}, fechadosPorClasse = {};
let ultCand = -1, ultExtra = -1;
const evento = new NativeCallback(function (tipo, lista, a, x) {
  try {
    if (tipo === EV.ABERTO) {
      const c = classe(a);
      // 12/11: o log "extra" saia SEM limite (36 mil linhas em 4 h, 6 mil so de WorldSettings; 5,5 MB). Agora 3 por classe e lista, como o [dist].
      if (lista <= 4) { const kk = lista + c; abertosPorClasse[kk] = (abertosPorClasse[kk] || 0) + 1; if (abertosPorClasse[kk] <= 3) log('[repl] canal aberto: ' + LISTA[lista] + ' ' + c + ' @' + a + ' ch=0x' + x.toString(16)); }
      else if (lista === 5) log('[donos] canal aberto (dono): ' + c + ' @' + a + ' dono=' + classe(a.add(0x140).readPointer()));
      else { abertosPorClasse[c] = (abertosPorClasse[c] || 0) + 1; if (abertosPorClasse[c] <= 3) log('[dist] canal aberto (distancia): ' + c + ' @' + a); }
    } else if (tipo === EV.REPL1) {
      const c = classe(a);
      if (lista <= 4) log('[repl] replicado ' + LISTA[lista] + ' ' + c + ': ' + x + ' bits');
      else log('[donos] replicado (dono) ' + c + ': ' + x + ' bits');
    } else if (tipo === EV.FECHADO) {
      const c = classe(a); fechadosPorClasse[c] = (fechadosPorClasse[c] || 0) + 1;
      if (fechadosPorClasse[c] <= 3) log('[dist] canal FECHADO (saiu do alcance): ' + c + ' @' + a);
    } else if (tipo === EV.SCAN) {
      const nCand = lista, nExtra = x.toNumber();
      if (nCand !== ultCand || nExtra !== ultExtra) {
        const pc = {};
        for (let i = 0; i < nCand && i < 5000; i++) { const c = classe(mem.cand.add(i * 8).readPointer()); pc[c] = (pc[c] || 0) + 1; }
        const top = Object.keys(pc).sort((p, q) => pc[q] - pc[p]).slice(0, 10).map(k => k + ':' + pc[k]).join(', ');
        log('[dist] candidatos: ' + nCand + ', sempre relevantes: ' + nExtra + ' (varridos ' + rd(mem.st, S.SCAN_TOTAL) + ' em ' +
          (rd(mem.st, S.SCAN_TICKS) * 1000 / QPF).toFixed(0) + ' ms, incremental) | ' + top);
        if (nExtra >= TAM.EXTRA) log('[otim] AVISO: lista de sempre relevantes CHEIA (' + TAM.EXTRA + '); os excedentes ficam sem canal -> aumentar TAM.EXTRA');
        ultCand = nCand; ultExtra = nExtra;
      }
    } else if (tipo === EV.DONOS || tipo === EV.FILHOS) {
      const s = lista, n = mem.donos_n.add(s * 4).readS32(), nomes = [];
      const ini = tipo === EV.FILHOS ? Math.max(0, n - x.toNumber()) : 0;
      for (let i = ini; i < n && nomes.length < 8; i++) nomes.push(classe(mem.donos.add((s * TAM.DONO + i) * 8).readPointer()));
      if (tipo === EV.DONOS) log('[donos] donos da conexao ' + a + ': ' + x + ' atores (' + nomes.join(',') + ')');
      else log('[donos] filhos: +' + x + ' ator(es) da conexao ' + a + ' (' + nomes.join(',') + ')');
    }
  } catch (e) { log('[otim] erro no evento ' + tipo + ': ' + e); }
}, 'void', ['int', 'int', 'pointer', 'int64']);

const classificar = new NativeCallback(function (cls) {
  try { const n = nomeObj(cls); if (PRESERVAR.test(n)) { log('[dist] classe preservada (canal nao fecha): ' + n); return 1; } } catch (e) {}
  return 0;
}, 'int', ['pointer']);

let cm;
try {
  cm = montar({ tdb_evento: evento, tdb_classificar: classificar,
    tdb_pre: B.add(RVA.callPreReplication), tdb_weak: B.add(RVA.makeWeak), tdb_find: B.add(RVA.findActorChannelRef),
    tdb_create: B.add(RVA.createChannelByName), tdb_setactor: B.add(RVA.setChannelActor), tdb_ready: B.add(RVA.isActorReady),
    tdb_initcomps: B.add(RVA.initReplicatedComponents), tdb_repl: B.add(RVA.replicateActor),
    tdb_qpc: k32.getExportByName('QueryPerformanceCounter') }, mem);
} catch (e) { log('[otim] ERRO compilando o modulo C (replicacao DESLIGADA; use a pasta host/): ' + e); return; }
// IMPORTANTE: o Frida libera Memory.alloc/NativeCallback/CModule quando o JS perde a referencia (coleta de lixo). O C guarda e
// chama esses enderecos para sempre: sem esta referencia global o jogo cairia quando o coletor rodasse (visto no teste fora do jogo).
globalThis.__tdbReplOtim = { cm, mem, evento, classificar, qpfBuf };
configurar(mem, QPF);
vset('GOBJ', B.add(RVA.gObjects));
Interceptor.attach(B.add(RVA.tickFlush), cm);   // onEnter nativo; nao faz nada ate PRONTO=1

// ---- dormencia: o jogo "acorda" atores dormentes (baus de loot ao abrir/fechar/mexer) com AActor::FlushNetDormancy; ForceNetUpdate
// pede envio imediato. Ganchos nos thunks nativos (UFunction+0xD8 = ExecFunction; 1o argumento = o ator) -> tdb_acordar no C.
function ganchosAcordar() {
  const g = B.add(RVA.gObjects), objs = g.readPointer(), num = g.add(0x14).readS32(), nch = g.add(0x1c).readS32();
  const quero = { FlushNetDormancy: null, ForceNetUpdate: null };
  for (let i = 0; i < num; i++) {
    const ch = (i / 0x10000) | 0; if (ch >= nch) break;
    try {
      const chunk = objs.add(ch * 8).readPointer(); if (chunk.isNull()) continue;
      const o = chunk.add((i % 0x10000) * 0x18).readPointer(); if (o.isNull()) continue;
      const n = nomeObj(o); if (!(n in quero) || quero[n]) continue;
      if (classe(o) !== 'Function' || nomeObj(o.add(0x20).readPointer()) !== 'Actor') continue;
      quero[n] = o;
      if (quero.FlushNetDormancy && quero.ForceNetUpdate) break;
    } catch (e) {}
  }
  const cm2 = new CModule(`
#include <gum/guminterceptor.h>
extern void tdb_acordar (void * a);
void onEnter (GumInvocationContext * ic) { tdb_acordar (gum_invocation_context_get_nth_argument (ic, 0)); }
`, { tdb_acordar: cm.tdb_acordar });
  globalThis.__tdbReplOtim.cm2 = cm2;
  const feitos = [];
  for (const n in quero) {
    if (!quero[n]) { log('[otim] AVISO: UFunction Actor.' + n + ' nao achada (dormentes so pela releitura de 10 s)'); continue; }
    const thunk = quero[n].add(0xd8).readPointer();
    Interceptor.attach(thunk, cm2); feitos.push(n + ' @' + thunk);
  }
  if (feitos.length) log('[otim] ganchos de acordar: ' + feitos.join(', '));
}
// os ganchos sao postos quando o driver de listen existe (ver prep): na partida do processo o modulo Engine ainda nao
// carregou e as UFunctions de Actor nao estao na GObjects (07/11: 'nao achada' com a busca feita no carregamento)
log('[otim] modulo C compilado (frequencia ' + (vget('GATING') ? 'LIGADA, piso ' + (vget('FREQMIN100') / 100) + '/s' : 'DESLIGADA') + '); esperando o driver de listen');

// ---- preparacao (thread do Frida): FNames, driver, ULevel::Actors, auto-teste da validacao pela GObjects ----
let idxActor = -1, idxWorld = -1;
function testarValidacao(world, off) {
  const g = B.add(RVA.gObjects), objs = g.readPointer(), num = g.add(0x14).readS32(), nch = g.add(0x1c).readS32();
  const L = world.add(0x30).readPointer(), arr = L.add(off).readPointer(), n = L.add(off + 8).readS32();
  let vistos = 0, volta = 0, mortos = 0;
  const mask = (1 << 21) | (1 << 28) | (1 << 29);
  let mortos28 = 0;
  for (let j = 0; j < n && vistos < 400; j++) {
    try {
      const a = arr.add(j * 8).readPointer(); if (a.isNull()) continue;
      vistos++;
      const idx = a.add(0xc).readS32(); if (idx < 0 || idx >= num || (idx >> 16) >= nch) continue;
      const item = objs.add((idx >> 16) * 8).readPointer().add((idx & 0xffff) * 0x18);
      if (!item.readPointer().equals(a)) continue;
      volta++;
      const fl = item.add(8).readS32();
      if (fl & mask) mortos++;
      if (fl & (1 << 28)) mortos28++;
    } catch (e) {}
  }
  if (vistos === 0 || volta < vistos * 0.9) { vset('VIVO_ON', 0); return 'DESLIGADA (GObjects nao bateu: ' + volta + '/' + vistos + ')'; }
  if (mortos > volta * 0.1) {
    if (mortos28 <= volta * 0.1) { vset('DEADMASK', 1 << 28); return 'so Unreachable (as outras flags marcavam ' + mortos + '/' + volta + ' atores vivos)'; }
    vset('DEADMASK', 0); return 'so o indice (flags marcavam ' + mortos + '/' + volta + ')';
  }
  return 'ok (' + volta + '/' + vistos + ' atores conferidos, ' + mortos + ' marcados)';
}
const prep = setInterval(function () {
  try {
    if (idxActor < 0) { idxActor = findFName('Actor'); idxWorld = findFName('World'); if (idxActor < 0) return; mem.nome_actor.writeU32(idxActor); mem.nome_actor.add(4).writeU32(0); }
    const eng = B.add(RVA.gEngine).readPointer();
    if (eng.isNull() || eng.add(0xec8).readS32() < 1) return;
    const w = eng.add(0xec0).readPointer().readPointer().add(0x2c0).readPointer();
    if (w.isNull() || w.add(0x10).readPointer().add(0x18).readU32() !== idxWorld) return;
    const d = w.add(0x38).readPointer();
    if (d.isNull() || classe(d) !== 'IpNetDriver' || !d.add(0x98).readPointer().isNull()) return;
    const L = w.add(0x30).readPointer(); let off = -1;
    for (let o = 0x80; o <= 0x120; o += 8) {
      try { const ar = L.add(o).readPointer(), n = L.add(o + 8).readS32();
        if (n > 0 && n < 200000 && !ar.isNull()) { const a0 = ar.readPointer(); if (!a0.isNull() && classe(a0).indexOf('WorldSettings') >= 0) { off = o; break; } } } catch (e) {}
    }
    if (off < 0) { log('[otim] ULevel::Actors nao achado; replicacao DESLIGADA'); clearInterval(prep); return; }
    const val = testarValidacao(w, off);
    vset('WORLD', w); vset('DRV', d); vset('OFFACT', off);
    vset('PRONTO', 1);
    clearInterval(prep);
    log('[otim] pronto: driver de listen ' + d + ' mundo ' + w + ', ULevel::Actors em +0x' + off.toString(16) + ', validacao pela GObjects: ' + val);
    try { ganchosAcordar(); } catch (e) { log('[otim] erro nos ganchos de acordar: ' + e); }
  } catch (e) {}
}, 500);

// ---- estatisticas a cada 60 s: tick, tempo do gancho por quadro, chamadas de replicacao ----
const T_STATS = 60;
setInterval(function () {
  try {
    if (!vget('PRONTO')) return;
    const q = rd(mem.st, S.QUADROS); if (q === 0) return;
    const tempo = rd(mem.st, S.TEMPO), tmax = rd(mem.st, S.TEMPO_MAX);
    const z = ['QUADROS', 'TEMPO', 'TEMPO_MAX', 'REPL', 'PULADOS', 'REPL_ESS', 'REPL_EXTRA', 'REPL_DONO', 'REPL_DIST', 'DORM_POUPADOS', 'ACORDADOS', 'NOVOS_ADIADOS'];
    const val = {}; for (const n of z) val[n] = rd(mem.st, S[n]);
    for (const n of z) mem.st.add(S[n] * 8).writeS64(0);
    const perto = [], donos = [];
    for (let s = 0; s < TAM.SLOTS; s++) if (!mem.slot_conn.add(s * 8).readPointer().isNull()) { perto.push(mem.perto_n.add(s * 4).readS32()); donos.push(mem.donos_n.add(s * 4).readS32()); }
    const ms = x => (x * 1000 / QPF).toFixed(2);
    log('[otim] ' + T_STATS + ' s: tick=' + (q / T_STATS).toFixed(1) + ' q/s | gancho medio=' + ms(tempo / q) + ' ms, max=' + ms(tmax) + ' ms | ' +
      'ReplicateActor=' + (val.REPL / T_STATS).toFixed(0) + '/s (essenciais ' + (val.REPL_ESS / T_STATS).toFixed(0) + ', extras ' + (val.REPL_EXTRA / T_STATS).toFixed(0) +
      ', donos ' + (val.REPL_DONO / T_STATS).toFixed(0) + ', perto ' + (val.REPL_DIST / T_STATS).toFixed(0) + '), poupados pela frequencia=' + (val.PULADOS / T_STATS).toFixed(0) + '/s, dormentes poupados=' + (val.DORM_POUPADOS / T_STATS).toFixed(0) + '/s, acordados=' + val.ACORDADOS + ', canais adiados (freio)=' + val.NOVOS_ADIADOS + ' | ' +
      'jogadores=' + perto.length + ' perto=[' + perto.join(',') + '] donos=[' + donos.join(',') + '] | candidatos=' + vget('NCAND') + ' extras=' + vget('NEXTRA') +
      ' | total: canais=' + rd(mem.st, S.CANAIS) + ' fechados=' + rd(mem.st, S.FECHADOS) + ' despejos=' + rd(mem.st, S.DESPEJOS) + ' semNivel=' + rd(mem.st, S.SEMNIVEL) +
      ' erroCriar=' + rd(mem.st, S.ERRO_CRIAR) + ' | tabela=' + vget('TABN') + '/' + TAM.TAB + (rd(mem.st, S.TAB_CHEIA) ? ' CHEIA x' + rd(mem.st, S.TAB_CHEIA) : ''));
  } catch (e) { log('[otim] erro nas estatisticas: ' + e); }
}, T_STATS * 1000);
})();
