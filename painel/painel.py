"""Painel local do servidor The Day Before (Azure + VPS).
Uso:  python -I painel\\painel.py      (ou abrir_painel.bat)  ->  abre http://127.0.0.1:8765 no navegador.
Roda SO no seu PC (escuta apenas 127.0.0.1): usa o Azure CLI ja logado (az login) e a chave SSH da VPS.
  - VM: ligar (alocar) e desalocar (antes de desalocar, derruba o servidor e salva os personagens).
  - Servidor: subir (versao normal ou otimizada; opcional: enviar antes os scripts do PC) e derrubar.
  - Monitores: cada um roda como processo separado na VPS (linux/carregar_ferramenta.sh) e liga/desliga ao vivo.
  - Jogadores ativos (do monitor de ping/posicao) e logs (runner, servicos, cada monitor).
Configuracao: painel\\config.json (criado na 1a vez; NAO vai para o GitHub)."""
import base64, io, json, os, re, secrets, shutil, subprocess, sys, tarfile, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
CFG = os.path.join(AQUI, "config.json")
PADRAO = {"grupo": "SEU_GRUPO_DE_RECURSOS", "vm": "SUA_VM", "ip": "", "usuario": "azureuser",
          "chave": os.path.join(os.path.expanduser("~"), ".ssh", "chave_da_vm.pem"), "porta": 8765,
          "pasta_remota": "~/tdb/servidor", "versao": "host_otimizado", "enviar_scripts": True,
          "monitores_ligados": ["monitor_ping", "monitor_posicao", "resgate_queda", "painel_ponte"],
          "backup_a_cada_min": 10}   # copia dos saves da VPS para este PC enquanto a VM estiver ligada (0 desliga)
MONITORES = [
    {"id": "monitor_ping", "caminho": "host/scripts/monitor_ping.js", "nome": "Ping dos jogadores",
     "desc": "Ping de cada jogador a cada 15 s. Alimenta a aba Jogadores.", "escreve": False},
    {"id": "monitor_posicao", "caminho": "host/scripts/monitor_posicao.js", "nome": "Posicao dos jogadores",
     "desc": "Posicao no servidor a cada 1 s; marca TELEPORTE, CAINDO e TROCOU PAWN.", "escreve": False},
    {"id": "resgate_queda", "caminho": "host/scripts/resgate_queda.js", "nome": "Resgate de queda",
     "desc": "Teleporta de volta quem cai no limbo (6 s caindo ou abaixo do mapa). ALTERA o jogo.", "escreve": True},
    {"id": "monitor_bugs", "caminho": "host/scripts/monitor_bugs.js", "nome": "Monitor de bugs",
     "desc": "Itens sumindo do inventario/bau e tiro em zumbi fantasma.", "escreve": False},
    {"id": "monitor_loot_tiro", "caminho": "host/ferramentas/monitor_loot_tiro.js", "nome": "Loot e tiro (teste)",
     "desc": "Abrir/pegar loot, canais dos baus e tiros entre jogadores. Para o teste com 2 pessoas.", "escreve": False},
    {"id": "painel_ponte", "caminho": "host/scripts/painel_ponte.js", "nome": "Ponte do painel (mapa, teleporte, dinheiro)",
     "desc": "Grava personagem, posicao e vida de cada jogador a cada 1 s (mapa e tabela) e executa o teleporte e o dinheiro pedidos aqui. So ALTERA o jogo quando voce pede.", "escreve": True},
]
POR_ID = {m["id"]: m for m in MONITORES}
TOKEN = secrets.token_urlsafe(24)
AZ_PY = r"C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe"


def ler_cfg():
    c = dict(PADRAO)
    if os.path.exists(CFG):
        try: c.update(json.load(open(CFG, encoding="utf-8")))
        except Exception as e: print("config.json invalido:", e)
    return c


def salvar_cfg(c):
    json.dump(c, open(CFG, "w", encoding="utf-8"), indent=2, ensure_ascii=False)


cfg = ler_cfg()
if not os.path.exists(CFG): salvar_cfg(cfg)
TRAVA_CFG = threading.Lock()


# ------------------------------------------------------------------ Azure CLI e SSH
def az(args, timeout=600, linha=None):
    cmd = ([AZ_PY, "-IBm", "azure.cli"] if os.path.exists(AZ_PY) else ["az"]) + args
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    saida = []
    t0 = time.time()
    for l in p.stdout:
        saida.append(l.rstrip())
        if linha: linha(l.rstrip())
        if time.time() - t0 > timeout: p.kill(); break
    p.wait()
    return p.returncode, "\n".join(saida)


def _achar_ssh():
    # prefere o OpenSSH do Windows; o ssh do Git (msys) nao entende "-F NUL" e quebrava o painel aberto pelo Git Bash
    win = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "OpenSSH", "ssh.exe")
    if os.path.exists(win): return win, "NUL"
    outro = shutil.which("ssh") or "ssh"
    return outro, ("/dev/null" if os.sep == "/" or "git" in outro.lower() or "msys" in outro.lower() else "NUL")


SSH_EXE, SSH_SEM_CFG = _achar_ssh()


def ssh_base(timeout=8):
    return [SSH_EXE, "-F", SSH_SEM_CFG, "-i", cfg["chave"], "-o", "BatchMode=yes", "-o", "ConnectTimeout=%d" % timeout,
            "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15", "%s@%s" % (cfg["usuario"], cfg["ip"])]


def ssh(script, timeout=60, linha=None, entrada_bin=None, comando="bash -s"):
    """Roda um script bash na VPS (enviado pela entrada; sem problemas de aspas). Devolve (codigo, saida)."""
    p = subprocess.Popen(ssh_base() + [comando], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    dados = entrada_bin if entrada_bin is not None else script.replace("\r\n", "\n").encode("utf-8")
    threading.Thread(target=lambda: (p.stdin.write(dados), p.stdin.close()), daemon=True).start()
    saida = []
    fim = time.time() + timeout
    while True:
        l = p.stdout.readline()
        if not l:
            break
        t = l.decode("utf-8", "replace").rstrip()
        saida.append(t)
        if linha: linha(t)
        if time.time() > fim:
            p.kill(); saida.append("(tempo esgotado)"); break
    p.wait()
    return p.returncode, "\n".join(saida)


# ------------------------------------------------------------------ estado
ESTADO_VPS = r'''python3 - <<'PYEOF'
import json, os, re, socket, subprocess, shlex, time
T = os.path.expanduser('~/.wine-tdb/drive_c/users/azureuser/AppData/Local/Temp')
S = os.path.expanduser('%PASTA%')
RUN = T + '/servidor_host_headless.out'
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
def porta(p):
    s = socket.socket(); s.settimeout(0.5)
    try: s.connect(('127.0.0.1', p)); return True
    except Exception: return False
    finally: s.close()
def ult(path, pat, n=1):
    if not os.path.exists(path): return []
    return sh('grep -F %s %s | tail -%d' % (shlex.quote(pat), shlex.quote(path), n)).splitlines()
r = {'ok': True}
r['servicos'] = {'firestore': porta(8081), 'tls': porta(443)}
rod = bool(sh("pgrep -f '[s]ervidor_host.py'").strip())
pasta = ''
try:
    m = re.search(r'pasta do host: (\S+)', open(S + '/logs/host_console.out', encoding='utf-8', errors='replace').readline()); pasta = m.group(1) if m else ''
except Exception: pass
l = ult(RUN, '[lnat] LISTEN OK') if rod else []
r['host'] = {'rodando': rod, 'pasta': pasta, 'listen': (l[-1][:8] if l else '')}
pid = sh("pgrep -f '[T]heDayBefore.exe' | head -1").strip()
if pid:
    ps = sh('ps -o rss=,pcpu=,etimes= -p ' + pid).split()
    if len(ps) >= 3: r['host'].update({'rss_mb': int(ps[0]) // 1024, 'cpu': float(ps[1]), 'segundos': int(ps[2])})
mem = sh('free -m').splitlines()[1].split()
r['vm'] = {'mem_total': int(mem[1]), 'mem_usada': int(mem[2]), 'carga': open('/proc/loadavg').read().split()[0]}
r['monitores_rodando'] = sorted(set(re.findall(r'([A-Za-z0-9_]+)\.js', sh("pgrep -fa '[c]arregar_script_no_host.py'"))))
# so vale log de monitor escrito depois que este host subiu (os *_host.out de execucoes anteriores ficam no TEMP)
inicio = 0.0
try:
    rp = sh("pgrep -of '[s]ervidor_host.py'").strip()
    if rp: inicio = time.time() - int(sh('ps -o etimes= -p ' + rp).strip()) - 5
except Exception: pass
def mon(nome):
    c = T + '/' + nome + '_host.out'
    try: return c if os.path.getmtime(c) >= inicio else ''
    except Exception: return ''
def ultm(nome, pat, n=1): c = mon(nome); return ult(c, pat, n) if c else []
pings = ultm('monitor_ping', '[ping]') + ult(RUN, '[ping]')
pings.sort(key=lambda x: x[:8])
jog = {}
if pings and rod:
    lin = pings[-1]; r['ping_hora'] = lin[:8]
    if 'jogador(es):' in lin:
        for parte in lin.split('jogador(es):', 1)[1].split('|'):
            m = re.match(r'\s*(.+?) = (\d+) ms', parte)
            if m: jog[m.group(1)] = {'nome': m.group(1), 'ping': int(m.group(2))}
for lin in sorted(ultm('monitor_posicao', '[pos]', 300) + ult(RUN, '[pos]', 300), key=lambda x: x[:8]):
    m = re.search(r'\[pos\] (\S+) \(([-\d.]+), ([-\d.]+), ([-\d.]+)\)(.*)', lin)
    if m and (m.group(1) in jog or not pings):
        j = jog.setdefault(m.group(1), {'nome': m.group(1)})
        j.update({'pos': [float(m.group(2)), float(m.group(3)), float(m.group(4))], 'pos_hora': lin[:8], 'marca': m.group(5).strip()[:80]})
r['jogadores'] = list(jog.values()) if rod else []
o = ult(RUN, '[otim] 60 s')
r['otim'] = o[-1][:400] if (o and rod) else ''
print(json.dumps(r))
PYEOF
'''

LOGS_VPS = r'''python3 - <<'PYEOF'
import base64, os, re
T = os.path.expanduser('~/.wine-tdb/drive_c/users/azureuser/AppData/Local/Temp')
S = os.path.expanduser('%PASTA%')
fonte, n, limpo = '%FONTE%', %N%, %LIMPO%
filtro = base64.b64decode('%FILTRO%').decode('utf-8').lower()
mapa = {'runner': T + '/servidor_host_headless.out', 'console': S + '/logs/host_console.out',
        'servicos': S + '/logs/servicos.out', 'firestore': S + '/logs/firestore_emu.log', 'export': S + '/logs/export.log'}
cam = mapa.get(fonte) or (T + '/' + fonte + '_host.out' if re.match(r'^[A-Za-z0-9_]+$', fonte) else '')
RUIDO = ('TickDispatch', 'quadro ', 'SPAWNHOOK', 'sempre relevantes listados', '] replicado ', 'canal aberto (distancia)')
if not cam or not os.path.exists(cam):
    print('(sem log: ' + (cam or fonte) + ')')
else:
    with open(cam, 'rb') as f:
        f.seek(0, 2); tam = f.tell(); f.seek(max(0, tam - 4000000)); txt = f.read().decode('utf-8', 'replace')
    out = []
    for l in txt.splitlines():
        if limpo and any(x in l for x in RUIDO): continue
        if filtro and filtro not in l.lower(): continue
        out.append(l[:600])
    print('\n'.join(out[-n:]) if out else '(nenhuma linha)')
PYEOF
'''

cache_vm = {"t": 0, "dados": {"estado": "?", "tamanho": ""}}


def estado_vm(forcar=False):
    if not forcar and time.time() - cache_vm["t"] < 30:
        return cache_vm["dados"]
    q = "{estado: instanceView.statuses[?starts_with(code,'PowerState/')].displayStatus | [0], tamanho: hardwareProfile.vmSize}"
    cod, out = az(["vm", "get-instance-view", "-g", cfg["grupo"], "-n", cfg["vm"], "--query", q, "-o", "json"], timeout=90)
    try:
        d = json.loads(out[out.index("{"):])
    except Exception:
        d = {"estado": "erro", "tamanho": "", "erro": out[-300:]}
    cache_vm.update(t=time.time(), dados=d)
    return d


def estado():
    vm = estado_vm()
    r = {"vm": vm, "ip": cfg["ip"], "versao": cfg["versao"], "enviar_scripts": cfg["enviar_scripts"],
         "monitores": [dict(m, ligado=(m["id"] in cfg["monitores_ligados"])) for m in MONITORES], "vps": None,
         "tarefa": tarefa_resumo()}
    if vm.get("estado") == "VM running":
        cod, out = ssh(ESTADO_VPS.replace("%PASTA%", cfg["pasta_remota"]), timeout=25)
        try: r["vps"] = json.loads(out.strip().splitlines()[-1])
        except Exception: r["vps"] = {"ok": False, "erro": out[-400:]}
    return r


def logs(fonte, n, filtro, limpo):
    if not re.match(r"^[A-Za-z0-9_]+$", fonte): return "(fonte invalida)"
    n = max(20, min(int(n), 3000))
    s = (LOGS_VPS.replace("%PASTA%", cfg["pasta_remota"]).replace("%FONTE%", fonte).replace("%N%", str(n))
         .replace("%LIMPO%", "True" if limpo else "False").replace("%FILTRO%", base64.b64encode(filtro.encode("utf-8")).decode()))
    cod, out = ssh(s, timeout=40)
    return out


# ------------------------------------------------------------------ tarefas longas (uma por vez)
TAREFA = {"id": 0, "nome": "", "linhas": [], "ativa": False, "ok": None, "inicio": 0}
TRAVA_T = threading.Lock()


def tarefa_resumo():
    return {k: TAREFA[k] for k in ("id", "nome", "ativa", "ok", "inicio")} | {"n": len(TAREFA["linhas"])}


def iniciar_tarefa(nome, fn):
    with TRAVA_T:
        if TAREFA["ativa"]:
            return False, "ja existe uma tarefa em andamento: " + TAREFA["nome"]
        TAREFA.update(id=TAREFA["id"] + 1, nome=nome, linhas=[], ativa=True, ok=None, inicio=time.time())

    def log(t):
        TAREFA["linhas"].append(time.strftime("%H:%M:%S ") + t)
        del TAREFA["linhas"][:-2000]

    def corpo():
        ok = False
        try:
            ok = bool(fn(log))
        except Exception as e:
            log("ERRO: %r" % e)
        TAREFA.update(ativa=False, ok=ok)
        log("== " + ("CONCLUIDO" if ok else "FALHOU"))
        cache_vm["t"] = 0
    threading.Thread(target=corpo, daemon=True).start()
    return True, "iniciado"


def esperar_ssh(log, segundos=240):
    log("esperando o SSH da VPS responder...")
    fim = time.time() + segundos
    while time.time() < fim:
        cod, out = ssh("echo pronto", timeout=15)
        if cod == 0 and "pronto" in out:
            log("SSH ok"); return True
        time.sleep(5)
    log("SSH nao respondeu"); return False


def t_ligar(log):
    log("ligando (alocando) a VM %s... a cobranca de CPU comeca agora" % cfg["vm"])
    cod, out = az(["vm", "start", "-g", cfg["grupo"], "-n", cfg["vm"]], linha=log)
    if cod != 0: return False
    return esperar_ssh(log)


# ------------------------------------------------------------------ backup dos saves para este PC
PASTA_BACKUP = os.path.join(RAIZ, "backups_vps")


def baixar_saves(log, motivo="manual"):
    """Baixa para este PC (backups_vps\AAAAMMDD_HHMMSS_<motivo>.tar.gz) o banco do Firestore (emu_data = ultimo export, e emu_data_anterior), os instantaneos de
    jogadores do backup_players.py (ultimos 60 + alertas.log), os relatorios de queda e a tabela de recursos. Roda sem derrubar nada; apos o 'derrubar'
    o emu_data e o export FINAL (todos os personagens salvos). Devolve True se o arquivo baixou e contem o banco."""
    import tarfile
    os.makedirs(PASTA_BACKUP, exist_ok=True)
    destino = os.path.join(PASTA_BACKUP, "%s_%s.tar.gz" % (time.strftime("%Y%m%d_%H%M%S"), motivo))
    remoto = ("cd %s && tar czf - --ignore-failed-read servicos/firestore_emu/emu_data servicos/firestore_emu/emu_data_anterior "
              "$(ls -t backups/players/*.json 2>/dev/null | head -60) backups/players/alertas.log logs/queda_*.txt logs/vigia_recursos.csv 2>/dev/null" % cfg["pasta_remota"])
    log("baixando os saves da VPS para %s ..." % destino)
    try:
        for tentativa in (1, 2):
            with open(destino, "wb") as f:
                # stdin=DEVNULL: o ssh do Windows, com o console do painel como entrada, nao termina (visto: download travado 5 min); stderr sem pipe para nao encher
                p = subprocess.Popen(ssh_base(15) + [remoto], stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                try: p.wait(timeout=120)
                except subprocess.TimeoutExpired:
                    p.kill(); log("AVISO: o download dos saves passou de 2 min (tentativa %d) e foi cancelado" % tentativa); continue
            try:
                with tarfile.open(destino) as t: nomes = t.getnames()
                break
            except Exception as e:
                log("AVISO: arquivo incompleto na tentativa %d: %r" % (tentativa, e))
        else:
            raise RuntimeError("o download nao completou nas 2 tentativas")
        with tarfile.open(destino) as t: nomes = t.getnames()
    except Exception as e:
        log("AVISO: backup dos saves FALHOU: %r" % e)
        try: os.remove(destino)
        except OSError: pass
        return False
    tem_banco = any(n.endswith("output-0") for n in nomes)
    log("backup %s: %d arquivos, %.0f KB, %s" % ("OK" if tem_banco else "INCOMPLETO (sem o banco)", len(nomes), os.path.getsize(destino) / 1024.0, os.path.basename(destino)))
    # retencao: 48 automaticos (~24 h) e 60 dos demais (manual/derrubar)
    for sufixo, manter in (("_auto.tar.gz", 48), ("_manual.tar.gz", 60), ("_derrubar.tar.gz", 60)):
        arqs = sorted(x for x in os.listdir(PASTA_BACKUP) if x.endswith(sufixo))
        for x in arqs[:-manter]:
            try: os.remove(os.path.join(PASTA_BACKUP, x))
            except OSError: pass
    return tem_banco


def t_backup(log):
    return baixar_saves(log, "manual")


_ULT_AUTO = {"t": time.time()}


def auto_backup():
    """A cada 'backup_a_cada_min' (padrao 10) baixa os saves, se a VM estiver ligada e nao houver outra tarefa. Silencioso (so imprime no console)."""
    while True:
        time.sleep(60)
        try:
            cada = int(cfg.get("backup_a_cada_min", 10) or 0)
            if cada <= 0 or time.time() - _ULT_AUTO["t"] < cada * 60 or TAREFA["ativa"]: continue
            if estado_vm().get("estado") != "VM running": continue
            _ULT_AUTO["t"] = time.time()
            baixar_saves(lambda t: print(time.strftime("%H:%M:%S "), "[backup auto]", t, flush=True), "auto")
        except Exception as e:
            print("[backup auto] erro:", repr(e), flush=True)


def t_derrubar(log):
    log("derrubando o servidor (host + export final do Firestore + servicos)...")
    cod, out = ssh("cd %s && bash linux/derrubar_tudo.sh" % cfg["pasta_remota"], timeout=300, linha=log)
    try: baixar_saves(log, "derrubar")   # copia do export FINAL para este PC (nao impede o desligamento se falhar)
    except Exception as e: log("AVISO: backup dos saves falhou: %r" % e)
    return cod == 0


def t_desalocar(log):
    if estado_vm(True).get("estado") == "VM running":
        if not t_derrubar(log):
            log("AVISO: nao consegui derrubar o servidor pelo SSH; desalocando mesmo assim (o ultimo export periodico fica valendo)")
    log("desalocando a VM (para a cobranca de CPU)...")
    cod, out = az(["vm", "deallocate", "-g", cfg["grupo"], "-n", cfg["vm"]], linha=log)
    return cod == 0


def enviar_scripts(log):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for pasta in ("host", "host_otimizado", "linux"):
            base = os.path.join(RAIZ, pasta)
            for dp, dn, fns in os.walk(base):
                dn[:] = [d for d in dn if d != "__pycache__"]
                for f in fns:
                    if f == "vps.conf": continue
                    cam = os.path.join(dp, f)
                    tar.add(cam, arcname=os.path.relpath(cam, RAIZ).replace("\\", "/"))
    dados = buf.getvalue()
    log("enviando host/, host_otimizado/ e linux/ do PC (%d KB; servicos e saves NAO sao tocados)..." % (len(dados) // 1024))
    cod, out = ssh(None, timeout=120, linha=log, entrada_bin=dados, comando="tar xf - -C %s" % cfg["pasta_remota"])
    return cod == 0


def ligar_monitor(log, mid):
    m = POR_ID[mid]
    log("ligando monitor %s..." % mid)
    cod, out = ssh("mkdir -p %s; cd %s && bash linux/carregar_ferramenta.sh %s 72" % (CMD_DIR, cfg["pasta_remota"], m["caminho"]), timeout=60, linha=log)
    return cod == 0


def desligar_monitor(log, mid):
    log("desligando monitor %s..." % mid)
    nome = os.path.basename(POR_ID[mid]["caminho"])
    cod, out = ssh("pkill -f '[c]arregar_script_no_host.py.*%s'; sleep 2; pgrep -fa '[c]arregar_script_no_host.py' | grep -c %s || true" % (nome, nome),
                   timeout=30, linha=log)
    return True


def t_subir(versao, enviar):
    def f(log):
        if estado_vm(True).get("estado") != "VM running":
            log("a VM nao esta ligada: ligue a VM primeiro"); return False
        if enviar and not enviar_scripts(log): return False
        log("subindo o servidor (%s)... leva de 2 a 4 minutos" % versao)
        cod, out = ssh("cd %s && TDB_HOST_PASTA=%s TDB_HOST_ARGS='--sem-monitores' bash linux/subir_tudo.sh"
                       % (cfg["pasta_remota"], versao), timeout=600, linha=log)
        if cod != 0 or "PRONTO" not in out: return False
        for mid in list(cfg["monitores_ligados"]):
            if mid in POR_ID: ligar_monitor(log, mid)
        return True
    return f


def t_monitor(mid, ligar):
    def f(log):
        with TRAVA_CFG:
            lig = [x for x in cfg["monitores_ligados"] if x != mid] + ([mid] if ligar else [])
            cfg["monitores_ligados"] = lig; salvar_cfg(cfg)
        if estado_vm().get("estado") != "VM running":
            log("VM desligada: a escolha fica salva e vale na proxima subida"); return True
        return ligar_monitor(log, mid) if ligar else desligar_monitor(log, mid)
    return f


PONTOS_PADRAO = [{"nome": "Woodberry (lobby)", "x": -971.5, "y": -42.4}, {"nome": "New City", "x": 1690, "y": -2035}]
# ------------------------------------------------------------------ mapa em tempo real, teleporte e dinheiro (painel_ponte.js no host)
CMD_DIR = '"$HOME/.wine-tdb/drive_c/users/$USER/AppData/Local/Temp/tdb_host_cmd"'
ROSTER = {"dados": None, "t": 0.0, "ativo_ate": 0.0}


def _roster_loop():
    """Mantem UMA conexao SSH aberta lendo jogadores.json a cada 1 s (sem reconectar a cada leitura); so enquanto alguem olha o mapa/tabela (ultimos 45 s)."""
    while True:
        if time.time() > ROSTER["ativo_ate"]:
            time.sleep(1); continue
        p = None
        try:
            remoto = 'f=%s/jogadores.json; while true; do tr -d "\\n" < "$f" 2>/dev/null; echo; sleep 1; done' % CMD_DIR
            p = subprocess.Popen(ssh_base(10) + [remoto], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for lin in p.stdout:
                if time.time() > ROSTER["ativo_ate"]: break
                try:
                    ROSTER["dados"] = json.loads(lin.decode("utf-8", "replace")); ROSTER["t"] = time.time()
                except Exception: pass
        except Exception: pass
        finally:
            try:
                if p: p.kill()
            except Exception: pass
        time.sleep(2)


def t_comando(cmd):
    """Escreve comando.json na VPS (a ponte executa cada id novo, uma vez, na thread do jogo) e espera resultado.json com o mesmo id."""
    def f(log):
        cid = int(time.time() * 1000)
        c = dict(cmd); c["id"] = cid
        cod, out = ssh('d=%s; test -n "$(find "$d/jogadores.json" -mmin -1 2>/dev/null)" && echo PONTE_OK || echo PONTE_PARADA' % CMD_DIR, timeout=30)
        if "PONTE_OK" not in out:
            log("A ponte do painel nao esta ativa no host: ligue o monitor 'Ponte do painel (mapa, teleporte, dinheiro)' na aba Monitores."); return False
        script = 'd=%s; mkdir -p "$d"; cat > "$d/comando.json" <<' % CMD_DIR + "'JSON'\n" + json.dumps(c, ensure_ascii=False) + "\nJSON\n"
        script += 'for i in $(seq 1 16); do grep -q "\\"id\\": *%d" "$d/resultado.json" 2>/dev/null && { cat "$d/resultado.json"; exit 0; }; sleep 0.7; done; echo SEM_RESULTADO\n' % cid
        log("enviando comando: " + json.dumps(cmd, ensure_ascii=False))
        cod, out = ssh(script, timeout=40)
        try:
            r = json.loads(out.strip().splitlines()[-1])
            log(("OK: " if r.get("ok") else "FALHOU: ") + str(r.get("msg")))
            return bool(r.get("ok"))
        except Exception:
            log("o host nao respondeu ao comando em ~11 s (ponte parada ou host ocupado)"); return False
    return f


# ------------------------------------------------------------------ HTTP
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _json(self, obj, cod=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(cod); self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _ok_token(self):
        return self.headers.get("X-Painel-Token") == TOKEN and self.headers.get("Host", "").split(":")[0] in ("127.0.0.1", "localhost")

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/":
            html = open(os.path.join(AQUI, "painel.html"), encoding="utf-8").read().replace("%TOKEN%", TOKEN)
            b = html.encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(b); return
        if u.path == "/mapa.png":
            arq = os.path.join(AQUI, "mapa.png")
            if self.headers.get("Host", "").split(":")[0] in ("127.0.0.1", "localhost") and os.path.exists(arq):
                b = open(arq, "rb").read(); self.send_response(200); self.send_header("Content-Type", "image/png"); self.send_header("Content-Length", str(len(b)))
                self.send_header("Cache-Control", "max-age=300"); self.end_headers(); self.wfile.write(b); return
            return self._json({"erro": "sem mapa.png"}, 404)
        if not self._ok_token(): return self._json({"erro": "token"}, 403)
        if u.path == "/api/estado":
            if q.get("forcar"): cache_vm["t"] = 0
            return self._json(estado())
        if u.path == "/api/mapa":
            ROSTER["ativo_ate"] = time.time() + 45
            idade = round(time.time() - ROSTER["t"], 1) if ROSTER["t"] else None
            return self._json({"dados": ROSTER["dados"], "idade": idade, "mapa": cfg.get("mapa") or {}, "pontos": cfg.get("pontos_mapa") or PONTOS_PADRAO})
        if u.path == "/api/tarefa":
            desde = int(q.get("desde", ["0"])[0])
            return self._json(tarefa_resumo() | {"linhas": TAREFA["linhas"][desde:]})
        if u.path == "/api/logs":
            return self._json({"texto": logs(q.get("fonte", ["runner"])[0], q.get("n", ["300"])[0], q.get("filtro", [""])[0],
                                              q.get("limpo", ["1"])[0] == "1")})
        self._json({"erro": "nao achado"}, 404)

    def do_POST(self):
        if not self._ok_token(): return self._json({"erro": "token"}, 403)
        n = int(self.headers.get("Content-Length", "0") or 0)
        try: d = json.loads(self.rfile.read(n) or b"{}")
        except Exception: return self._json({"erro": "json"}, 400)
        a = d.get("acao")
        if a == "ligar_vm": ok, msg = iniciar_tarefa("Ligar VM", t_ligar)
        elif a == "desalocar_vm": ok, msg = iniciar_tarefa("Desalocar VM", t_desalocar)
        elif a == "subir":
            versao = d.get("versao") if d.get("versao") in ("host", "host_otimizado") else "host_otimizado"
            with TRAVA_CFG: cfg["versao"] = versao; cfg["enviar_scripts"] = bool(d.get("enviar", True)); salvar_cfg(cfg)
            ok, msg = iniciar_tarefa("Subir servidor (%s)" % versao, t_subir(versao, cfg["enviar_scripts"]))
        elif a == "derrubar": ok, msg = iniciar_tarefa("Derrubar servidor", t_derrubar)
        elif a == "backup": ok, msg = iniciar_tarefa("Baixar saves para este PC", t_backup)
        elif a == "mapa_cfg":
            try:
                ref = d["ref"]; novo = {"esc": float(d["esc"]), "inv": bool(d.get("inv")), "ref": {k: float(ref[k]) for k in ("wx", "wy", "px", "py")}}
                if not (0.05 <= novo["esc"] <= 20): raise ValueError("escala")
            except Exception: return self._json({"erro": "calibracao invalida"}, 400)
            with TRAVA_CFG: cfg["mapa"] = novo; salvar_cfg(cfg)
            ok, msg = True, "calibracao salva"
        elif a == "teleportar" and d.get("alvo"):
            cmd = {"cmd": "teleportar", "alvo": str(d["alvo"])[:60]}
            if d.get("para"): cmd["para"] = str(d["para"])[:60]
            elif d.get("destino") == "woodberry": cmd["destino"] = "woodberry"
            else:
                try: cmd.update(x=float(d["x"]), y=float(d["y"]), z=float(d["z"]))
                except Exception: return self._json({"erro": "destino invalido"}, 400)
            ok, msg = iniciar_tarefa("Teleportar " + cmd["alvo"], t_comando(cmd))
        elif a == "dinheiro" and d.get("alvo"):
            try: valor = int(d.get("valor"))
            except Exception: return self._json({"erro": "valor invalido"}, 400)
            if not (1 <= valor <= 1000000): return self._json({"erro": "valor de 1 a 1.000.000"}, 400)
            ok, msg = iniciar_tarefa("Dinheiro para " + str(d["alvo"])[:60], t_comando({"cmd": "dinheiro", "alvo": str(d["alvo"])[:60], "valor": valor}))
        elif a == "monitor" and d.get("id") in POR_ID:
            ok, msg = iniciar_tarefa(("Ligar " if d.get("ligar") else "Desligar ") + d["id"], t_monitor(d["id"], bool(d.get("ligar"))))
        else: return self._json({"erro": "acao invalida"}, 400)
        self._json({"ok": ok, "msg": msg})


def main():
    if not cfg.get("ip"):
        print("Configure o IP da VPS em", CFG); return
    if not os.path.exists(cfg["chave"]):
        print("Chave SSH nao encontrada:", cfg["chave"], "(ajuste 'chave' em", CFG + ")")
    threading.Thread(target=auto_backup, daemon=True).start()
    threading.Thread(target=_roster_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", int(cfg["porta"])), H)
    url = "http://127.0.0.1:%d/" % int(cfg["porta"])
    print("Painel em", url, "(feche esta janela para encerrar)")
    if "--sem-navegador" not in sys.argv: webbrowser.open(url)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass


if __name__ == "__main__":
    main()
