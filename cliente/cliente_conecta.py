"""Cliente: abre o jogo como um jogador comum que entra no servidor local. Ver README.md na raiz do repositorio.

Rode em OUTRA conta do Windows (nao na conta do host): o banco local do Firestore em %LOCALAPPDATA% so abre em um
processo por usuario. Nessa conta: Python + pacote frida, e acesso de leitura a pasta do jogo.

O que faz:
  - escolhe o SteamId do jogador (TDB_STEAMID > cliente\steamid.txt > ID gerado na 1a vez e guardado em
    %LOCALAPPDATA%	db_cliente\steamid.txt) e grava no emulador Goldberg antes de abrir o jogo: cada pessoa = um personagem;
  - cria steam_settings\disable_lan_only.txt se faltar (sem ele o join num servidor na internet falha);
  - abre o jogo com tdb_connectex_test.js (Google:443 -> terminador TLS local; verificacao de certificado desligada em
    memoria) e tdb_fname_join.js (o join do Server Browser vai para 127.0.0.1:7777);
  - fica rodando ate o jogo fechar. Depois: login, Server Browser, Atualizar, SERVIDOR-LOCAL.

Uso:  python cliente_conecta.py [--host <ip> | --local] [--diag] [--sem-barras-fixas] [--sem-aparencia] [segundos]
      (servidor na internet: ponha o IP num arquivo host.txt ao lado deste script)
      --diag  liga os scripts de diagnostico de diagnostico\\ (mais lento)
Pasta do jogo: variavel de ambiente TDB_JOGO (padrao C:\\Games\\THE DAY BEFORE).
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

import frida

DIR = Path(__file__).resolve().parent
JS = DIR / "tdb_connectex_test.js"
LOG = DIR / ("cliente_frida_%s.log" % (os.environ.get("USERNAME", "") or "cliente").lower())   # um log por conta (2 clientes no mesmo PC)
def _pasta_jogo():
    """08/11: TDB_JOGO (o launcher passa) > pasta escolhida no launcher (launcher\config.json) > padrao. Devolve (pasta, origem)."""
    if os.environ.get("TDB_JOGO"):
        return os.environ["TDB_JOGO"], "variavel TDB_JOGO"
    try:
        import json as _json
        cfg = _json.loads((Path(__file__).resolve().parent.parent / "launcher" / "config.json").read_text(encoding="utf-8"))
        if cfg.get("pasta_jogo"):
            return cfg["pasta_jogo"], "escolhida no launcher (launcher\config.json)"
    except Exception:
        pass
    return r"C:\Games\THE DAY BEFORE", "padrao"


JOGO, ORIGEM_JOGO = _pasta_jogo()
WD = os.path.join(JOGO, r"Survival\Binaries\Win64")
EXE = os.path.join(WD, "TheDayBefore.exe")
DIAG = DIR / "diagnostico"
UE_LOGS = Path(os.path.expandvars(r"%LOCALAPPDATA%\Survival\Saved\Logs"))


# Identidade Steam do CLIENTE (emulador Goldberg). O emulador le o ID de arquivos na pasta do jogo ao abrir o processo, e este
# script os regrava a cada abertura (por isso editar o force_steamid.txt a mao nao adianta). O host usa 76561197960271872.
# Cada jogador precisa de um SteamId diferente: o personagem fica em players/<SteamId> no Firestore do servidor.
# Ordem (07/11):
#   1) variavel TDB_STEAMID (e TDB_NOME);
#   2) cliente\steamid.txt ao lado deste script (escolha manual: 1a linha o ID, 2a linha opcional o nome);
#   3) as duas contas do PC do dono do servidor (tabela abaixo; cada uma ja tem personagem);
#   4) ID gerado na 1a vez e guardado POR CONTA DO WINDOWS em %LOCALAPPDATA%\tdb_cliente\steamid.txt, para continuar o mesmo
#      mesmo que a pasta do cliente seja trocada por uma versao nova. Apagar esse arquivo = personagem novo.
# Dois clientes no mesmo PC: use contas do Windows diferentes; abra um, espere chegar ao menu e so entao abra o outro.
IDS_POR_CONTA = {
    "teste": ("76561197960287930", "Jogador1"),
    "yan":   ("76561197960287931", "Jogador2"),
}
ID_AUTO = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "tdb_cliente" / "steamid.txt"
STEAM_ENGINE = Path(JOGO) / r"Engine\Binaries\ThirdParty\Steamworks\Steamv153\Win64\steam_settings"
STEAM_CFG = Path(WD) / r"steam_settings\configs.user.ini"


def _nome_ascii(bruto: str, reserva: str) -> str:
    n = "".join(c for c in bruto if c.isascii() and (c.isalnum() or c in "-_"))[:16]
    return n or reserva


def _ler_id(arq: Path):
    """(id, nome) de um arquivo steamid.txt, ou None se nao existir / for invalido."""
    try:
        linhas = [l.strip() for l in arq.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
    except OSError:
        return None
    if not linhas or not (linhas[0].isdigit() and len(linhas[0]) == 17 and linhas[0].startswith("7656119")):
        if linhas:
            print(f"AVISO: {arq} nao tem um SteamId valido (17 digitos comecando com 7656119); ignorado", flush=True)
        return None
    return linhas[0], (linhas[1] if len(linhas) > 1 else "")


# 08/11: --local = servidor no proprio PC (ignora host.txt/TDB_HOST). O launcher usa no modo Offline.
LOCAL = "--local" in sys.argv
ID_LOCAL_ANTIGO = ("76561197960287930", "Jogador1")   # ID que o cliente antigo dava a todos: os saves do host local estao nele


def escolher_identidade():
    """Devolve (steam_id, nome, origem)."""
    conta = os.environ.get("USERNAME", "") or "jogador"
    if os.environ.get("TDB_STEAMID"):
        sid = os.environ["TDB_STEAMID"].strip()
        return sid, _nome_ascii(os.environ.get("TDB_NOME", ""), _nome_ascii(conta, "Jogador")), "variavel TDB_STEAMID"
    if LOCAL:   # servidor local: mantem o ID de sempre (contas do dono pela tabela; os demais no ID antigo) para os saves locais
        sid, nome = IDS_POR_CONTA.get(conta.lower(), ID_LOCAL_ANTIGO)
        return sid, os.environ.get("TDB_NOME", nome), "modo local (ID dos saves do host local)"
    manual = _ler_id(DIR / "steamid.txt")
    if manual:
        return manual[0], _nome_ascii(os.environ.get("TDB_NOME", "") or manual[1], _nome_ascii(conta, "Jogador")), str(DIR / "steamid.txt")
    if conta.lower() in IDS_POR_CONTA:
        sid, nome = IDS_POR_CONTA[conta.lower()]
        return sid, os.environ.get("TDB_NOME", nome), "conta do Windows '" + conta + "'"
    auto = _ler_id(ID_AUTO)
    if auto:
        return auto[0], _nome_ascii(os.environ.get("TDB_NOME", "") or auto[1], _nome_ascii(conta, "Jogador")), str(ID_AUTO)
    # 1a vez nesta conta do Windows: gera um ID unico (76561198 + 9 digitos aleatorios = 17 digitos, longe dos IDs fixos)
    import secrets
    sid = "76561198" + str(100000000 + secrets.randbelow(900000000))
    nome = _nome_ascii(os.environ.get("TDB_NOME", "") or conta, "Jogador" + sid[-4:])
    try:
        ID_AUTO.parent.mkdir(parents=True, exist_ok=True)
        ID_AUTO.write_text(sid + "\n" + nome + "\n", encoding="utf-8")
        origem = "NOVO, guardado em " + str(ID_AUTO)
    except OSError as e:
        origem = f"NOVO, mas nao consegui guardar em {ID_AUTO} ({e}): na proxima abertura sera outro personagem"
    return sid, nome, origem


CLIENTE_STEAM_ID, CLIENTE_NOME, ORIGEM_ID = escolher_identidade()


def definir_identidade(steam_id: str, nome: str) -> None:
    ok = True
    try:
        STEAM_ENGINE.mkdir(parents=True, exist_ok=True)
        (STEAM_ENGINE / "force_steamid.txt").write_bytes(steam_id.encode("ascii"))
        (STEAM_ENGINE / "force_account_name.txt").write_bytes(nome.encode("ascii", "replace"))
    except OSError as e:
        ok = False
        print(f"AVISO: nao consegui gravar force_steamid.txt em {STEAM_ENGINE} ({e}). Rode o terminal como administrador "
              f"ou de permissao de escrita na pasta do jogo; sem isso todos entram com o mesmo ID.", flush=True)
    try:
        if STEAM_CFG.exists():
            linhas = STEAM_CFG.read_text(encoding="ascii", errors="replace").splitlines()
            linhas = [("steam_id = " + steam_id) if l.strip().startswith("steam_id") else
                      ("account_name = " + nome) if l.strip().startswith("account_name") else l for l in linhas]
            STEAM_CFG.write_text("\n".join(linhas) + "\n", encoding="ascii", errors="replace")
    except OSError as e:
        print(f"AVISO: nao consegui atualizar {STEAM_CFG} ({e})", flush=True)
    if ok:
        print(f"identidade Steam do cliente: {steam_id} ({nome}) - origem: {ORIGEM_ID}", flush=True)


def liberar_fora_da_lan() -> None:
    """Sem steam_settings\disable_lan_only.txt o emulador de Steam bloqueia em silencio o trafego do jogo para IPs fora da rede
    local (o join num servidor na internet da 'erro de conexao'). Cria o arquivo se faltar; nao atrapalha o servidor local."""
    arq = STEAM_ENGINE / "disable_lan_only.txt"
    if arq.exists():
        return
    try:
        STEAM_ENGINE.mkdir(parents=True, exist_ok=True)
        arq.write_bytes(b"")
        print(f"criado {arq} (libera conexao com servidores fora da rede local)", flush=True)
    except OSError as e:
        print(f"AVISO: nao consegui criar {arq} ({e}). Crie esse arquivo vazio a mao, senao a conexao com o servidor falha.", flush=True)


def limpar_temp_frida(horas: float = 1) -> int:
    """06/11: o Frida extrai o agente (~61 MB) em %TEMP%\frida-<codigo> a cada abertura e so apaga quando o Python termina limpo;
    sem isso as pastas acumulam (no host chegaram a 60 GB). Apaga as com mais de `horas`; as em uso falham e ficam."""
    import tempfile
    base, n = tempfile.gettempdir(), 0
    for nome in os.listdir(base):
        if not nome.startswith("frida-"):
            continue
        p = os.path.join(base, nome)
        try:
            if time.time() - os.path.getmtime(p) < horas * 3600:
                continue
            shutil.rmtree(p)
            n += 1
        except Exception:
            pass
    return n


def args_tela() -> list:
    """Modo e resolucao da tela, escolhidos no launcher (TDB_TELA_MODO / TDB_TELA_RES) ou por --tela-modo / --tela-res.
    'padrao' nao forca nada: vale o que o jogo salvou nas proprias configuracoes. Antes (ate 12/11) o jogo era aberto sempre com -windowed -ResX=1280 -ResY=720,
    e a pessoa ficava presa nessa janela (tela cheia caia para 720p, trocar a resolucao no jogo virava janela)."""
    import re as _re
    modo = os.environ.get("TDB_TELA_MODO", "padrao")
    res = os.environ.get("TDB_TELA_RES", "padrao")
    for i, a in enumerate(sys.argv):
        if a == "--tela-modo" and i + 1 < len(sys.argv): modo = sys.argv[i + 1]
        if a == "--tela-res" and i + 1 < len(sys.argv): res = sys.argv[i + 1]
    args = []
    if modo == "janela": args.append("-windowed")
    elif modo == "tela_cheia": args.append("-fullscreen")
    if res == "monitor":
        try:
            import ctypes
            ctypes.windll.user32.SetProcessDPIAware()   # tamanho real do monitor, sem a escala do Windows
            res = "%dx%d" % (ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1))
        except Exception:
            res = "padrao"
    m = _re.fullmatch(r"(\d{3,5})x(\d{3,5})", res)
    if m: args += ["-ResX=" + m.group(1), "-ResY=" + m.group(2)]
    return args


def on_message(message, data):
    line = str(message.get("payload")) if message.get("type") == "send" else str(message)
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(time.strftime("%H:%M:%S ") + line + "\n")


def copy_ue_logs() -> None:
    # Copia o log mais recente do Unreal para a pasta do cliente (para ver o motivo da falha).
    if not UE_LOGS.exists():
        print(f"pasta de logs do jogo nao encontrada: {UE_LOGS}", flush=True)
        return
    files = [p for p in UE_LOGS.rglob("*") if p.is_file()]
    if not files:
        print(f"nenhum log em {UE_LOGS}", flush=True)
        return
    newest = max(files, key=lambda p: p.stat().st_mtime)
    dest = DIR / ("ue_" + newest.name)
    shutil.copy2(newest, dest)
    print(f"log do jogo copiado: {dest}", flush=True)


def ponte_firestore(host: str, porta: int = 443) -> bool:
    """Host remoto (VPS): o tdb_connectex_test.js manda o Firestore do jogo para 127.0.0.1:443 / [::1]:443. Esta ponte, num thread,
    repassa essas conexoes (bytes crus, o TLS e terminado na VPS) para host:443. Devolve False se a 443 local ja estiver ocupada
    (por exemplo um terminador TLS local antigo ainda aberto)."""
    import asyncio, threading

    async def tratar(r, w):
        try:
            ur, uw = await asyncio.wait_for(asyncio.open_connection(host, porta), 10)
        except Exception as e:
            print(f"ponte: nao conectei em {host}:{porta} ({e})", flush=True); w.close(); return

        async def cano(a, b):
            try:
                while True:
                    d = await a.read(65536)
                    if not d:
                        break
                    b.write(d); await b.drain()
            except Exception:
                pass
            finally:
                try: b.close()
                except Exception: pass
        await asyncio.gather(cano(r, uw), cano(ur, w))

    pronto, ok = threading.Event(), {"v": True}

    def rodar():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            servs = [loop.run_until_complete(asyncio.start_server(tratar, h, porta)) for h in ("127.0.0.1", "::1")]
        except OSError as e:
            print(f"ponte: porta {porta} local ocupada ({e}). Feche o terminador TLS local, se houver.", flush=True)
            ok["v"] = False; pronto.set(); return
        pronto.set()
        loop.run_forever()

    threading.Thread(target=rodar, daemon=True).start()
    pronto.wait(5)
    if ok["v"]:
        print(f"ponte do Firestore: 127.0.0.1:{porta} e [::1]:{porta} -> {host}:{porta}", flush=True)
    return ok["v"]


def main() -> int:
    # 06/11: antes o padrao era 900 s; apos 15 min o script soltava o jogo (session.detach) e fechava a janela,
    # e os monitores paravam no meio do jogo. Agora o padrao (0) e ficar ate o jogo fechar; um numero > 0 ainda limita o tempo.
    # 06/11 (modo leve, padrao): so os scripts que mudam o comportamento (redirecionamento do Firestore e do join).
    # Com --diag volta tudo: diagnosticos de UDP/travel/ProcessEvent, monitor do GPS e gRPC em modo debug.
    diag = "--diag" in sys.argv
    print(f"pasta do jogo: {JOGO} ({ORIGEM_JOGO})", flush=True)
    if not os.path.isfile(EXE):
        print(f"ERRO: nao achei o jogo em {EXE}. Escolha a pasta certa no launcher (Escolher...) ou defina TDB_JOGO.", flush=True)
        return 1
    # Host remoto: --host <IPv4> (ou variavel TDB_HOST). Sem isso, o host e este PC (127.0.0.1).
    host = sys.argv[sys.argv.index("--host") + 1] if "--host" in sys.argv else os.environ.get("TDB_HOST", "")
    # Sem --host/TDB_HOST: usa o IP do arquivo host.txt ao lado deste script (uma linha; apague o arquivo para voltar ao host local).
    if LOCAL:
        host = ""
        print("modo local: servidor neste PC (host.txt ignorado)", flush=True)
    if not host and not LOCAL and (DIR / "host.txt").exists():
        host = (DIR / "host.txt").read_text(encoding="utf-8").strip()
        if host:
            print(f"host lido de host.txt: {host}", flush=True)
    if host:
        print(f"host remoto: {host} (join para {host}:7777, Firestore pela ponte)", flush=True)
        if not ponte_firestore(host):
            # Dois clientes no mesmo PC: a ponte do primeiro (em 127.0.0.1:443) serve aos dois, de qualquer conta. Se a 443 ja
            # responde, seguimos usando ela. Atencao: se o cliente que abriu a ponte fechar, o outro perde o Firestore.
            import socket
            try:
                socket.create_connection(("127.0.0.1", 443), 2).close()
                print("porta 443 local ja tem uma ponte (de outro cliente aberto): usando ela. Nao feche o primeiro cliente.", flush=True)
            except OSError:
                return 1
    nums = [a for a in sys.argv[1:] if a.isdigit() and a != host]
    seconds = int(nums[0]) if nums else 0
    env = dict(os.environ)
    if diag:   # gRPC em modo debug (conexao com o Firestore): muito texto no stdout, custa desempenho
        env["GRPC_VERBOSITY"] = "DEBUG"
        env["GRPC_TRACE"] = "tsi,ssl_transport_security,tcp,client_channel"
    print("modo: " + ("DIAGNOSTICO (--diag)" if diag else "LEVE (sem monitores; use --diag para liga-los)"), flush=True)
    definir_identidade(CLIENTE_STEAM_ID, CLIENTE_NOME)
    liberar_fora_da_lan()
    n_lixo = limpar_temp_frida()
    if n_lixo:
        print(f"limpeza: {n_lixo} pastas antigas do Frida apagadas do TEMP", flush=True)
    device = frida.get_local_device()
    print("abrindo o jogo como cliente (tela: %s)..." % (" ".join(args_tela()) or "padrao do jogo"), flush=True)
    pid = device.spawn(
        [EXE] + args_tela() + ["-FullStdOutLogOutput"],
        cwd=WD,
        env=env,
    )
    session = device.attach(pid)
    # Necessarios: tdb_connectex_test.js (Firestore/lista -> terminador TLS local) e tdb_fname_join.js (join -> 127.0.0.1:7777).
    # Diagnosticos (so com --diag): tdb_join_udp.js, tdb_travel_log.js, tdb_pe_travel.js (hook em ProcessEvent).
    partes = [JS, DIR / "tdb_fname_join.js"]
    if host and (DIR / "redireciona_join.js").exists():   # 10/11: join sempre para o host.txt, mesmo com lista de servidores velha
        partes.append(DIR / "redireciona_join.js")
    if diag:
        partes += [DIAG / "tdb_join_udp.js", DIAG / "tdb_travel_log.js", DIAG / "tdb_pe_travel.js"]
    source = "\n".join(p.read_text(encoding="utf-8") for p in partes)
    if host:
        source = "var TDB_HOST = %r;\n" % host + source
    script = session.create_script(source)
    script.on("message", on_message)
    script.load()
    # 07/11: vida, fome e sede sempre na tela (o HUD do jogo so as mostra quando um valor sobe ou fica critico). Script separado:
    # um erro nele nao derruba os outros. --sem-barras-fixas desliga.
    barras = DIR / "barras_sempre_visiveis.js"
    if "--sem-barras-fixas" not in sys.argv and barras.exists():
        script_barras = session.create_script(barras.read_text(encoding="utf-8"))
        script_barras.on("message", on_message)
        script_barras.load()
    # 07/11: monta rosto/cabelo dos outros jogadores quando o multicast UpdateSaveCharactersMulticast se perde (sem cabeca).
    # So visual, a cada 2 s, uma chamada por jogador sem rosto. --sem-aparencia desliga.
    aparencia = DIR / "aparencia_outros.js"
    if "--sem-aparencia" not in sys.argv and aparencia.exists():
        script_aparencia = session.create_script(aparencia.read_text(encoding="utf-8"))
        script_aparencia.on("message", on_message)
        script_aparencia.load()
    # 12/11: extras de jogo, cada um em script separado (um erro nele nao derruba os outros). Todos esperam o jogador entrar no mapa
    # (o jogo e aberto aqui antes de existir a GObjects) e se refazem ao trocar de mapa:
    #   voz_cliente.js        chat de voz de proximidade (AllowVoice + VoipManager.InitVoice; o jogo traz o recurso mas nao o liga)   --sem-voz
    #   hud_grupo_cliente.js  lista do grupo (nome do personagem, lider, barra de vida) no canto da tela, no idioma do launcher    --sem-hud-grupo
    #   vida_jogo_cliente.js  conserta a barra de vida da HUD de baixo (nada chamava o SetValue do widget)                        --sem-vida
    idioma = "en"
    try:
        import json as _json
        idioma = _json.loads((Path(__file__).resolve().parent.parent / "launcher" / "config.json").read_text(encoding="utf-8")).get("idioma", "en")
    except Exception:
        pass
    for arq, flag in (("voz_cliente.js", "--sem-voz"), ("hud_grupo_cliente.js", "--sem-hud-grupo"), ("vida_jogo_cliente.js", "--sem-vida")):
        p = DIR / arq
        if flag in sys.argv or not p.exists():
            continue
        try:
            s_extra = session.create_script(p.read_text(encoding="utf-8").replace("__IDIOMA__", idioma))
            s_extra.on("message", on_message)
            s_extra.load()
        except Exception as e:   # nunca impede o jogo de abrir
            print(f"AVISO: {arq} nao carregou: {e}", flush=True)
    # Monitor opcional (somente leitura) do GPS no cliente, em script separado para um erro nele nao derrubar os demais.
    extra = DIAG / "monitor_gps_cliente.js"
    if diag and extra.exists():
        script2 = session.create_script(extra.read_text(encoding="utf-8"))
        script2.on("message", on_message)
        script2.load()
    device.resume(pid)
    print(f"cliente pid={pid}. Faca o login, abra o Server Browser e entre no servidor.", flush=True)
    fechou = {"v": False}
    session.on("detached", lambda reason, crash=None: (fechou.__setitem__("v", True), print(f"jogo fechado/desanexado: {reason}", flush=True)))
    fim = time.time() + seconds if seconds > 0 else None
    try:
        while not fechou["v"] and (fim is None or time.time() < fim):
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    if not fechou["v"]:
        session.detach()
    copy_ue_logs()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


