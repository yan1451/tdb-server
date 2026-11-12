"""TDB Launcher (08/11/2026): abre The Day Before no servidor da comunidade (Online) ou no servidor do proprio PC (Offline),
e atualiza o cliente pelo GitHub Releases. Abrir com "Abrir TDB Launcher.bat" na raiz do projeto.

Online : python cliente\\cliente_conecta.py           (IP em cliente\\host.txt; SteamId unico da pessoa)
Offline: python host\\servidor_host.py --appdata-separado  -> espera "[lnat] LISTEN OK" -> python cliente\\cliente_conecta.py --local
         (ID antigo, onde estao os saves locais). Ao fechar o jogo: fecha o host (export final do Firestore) e desliga os servicos
         locais (emulador e terminador TLS na 443), para o modo Online poder abrir a ponte na 443 depois.
Pasta do jogo: escolhida na janela ("Escolher..."), guardada em launcher\\config.json (local; a atualizacao nunca mexe nele).
"""
from __future__ import annotations

import json
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
import traceback
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent
sys.path.insert(0, str(AQUI))
import atualizador  # noqa: E402
import idiomas  # noqa: E402

CFG_ARQ = AQUI / "config.json"
CLIENTE = RAIZ / "cliente" / "cliente_conecta.py"
HOST = RAIZ / "host" / "servidor_host.py"
# 10/11: o Offline usa o host_otimizado (replicacao em C, sem o limite de 150 atores sempre relevantes) com os mesmos argumentos
# da VPS. O host normal (replicacao em JS a cada quadro + monitores) rodava a 9-15 quadros/s com 1 jogador: atraso e itens demorando.
HOST_OTIM = RAIZ / "host_otimizado" / "servidor_host.py"
ARGS_HOST_OFFLINE = ["--appdata-separado", "--sem-monitores", "--sem-resgate"]
HOST_TXT = RAIZ / "cliente" / "host.txt"
LOG_HOST = Path(os.environ.get("TEMP", ".")) / "servidor_host_headless.out"
SEM_JANELA = getattr(subprocess, "CREATE_NO_WINDOW", 0)
IMAGENS_SERVICO = {"java.exe", "node.exe", "python.exe", "pythonw.exe"}
LOG_LAUNCHER = AQUI / "launcher.log"
_trava_log = threading.Lock()


def gravar_log(texto: str) -> None:
    """Tudo que aparece na janela vai tambem para launcher\\launcher.log (para o jogador mandar quando der erro)."""
    with _trava_log:
        try:
            if LOG_LAUNCHER.exists() and LOG_LAUNCHER.stat().st_size > 2_000_000:
                os.replace(LOG_LAUNCHER, LOG_LAUNCHER.with_name("launcher.log.anterior"))
            with open(LOG_LAUNCHER, "a", encoding="utf-8") as f:
                f.write(texto.rstrip("\n") + "\n")
        except OSError:
            pass


class _SaidaParaLog:
    """No pythonw nao ha console: print e erros soltos iriam para lugar nenhum. Manda para o launcher.log."""
    def write(self, t):
        if t and t.strip():
            gravar_log(time.strftime("%H:%M:%S ") + t)

    def flush(self):
        pass


if sys.stderr is None or sys.stdout is None:
    sys.stdout = sys.stderr = _SaidaParaLog()


def frida_instalado(py: str) -> str:
    """Versao do frida no Python que vai rodar o cliente, ou '' se nao estiver instalado."""
    try:
        r = subprocess.run([py, "-I", "-c", "import frida; print(frida.__version__)"], capture_output=True, text=True, timeout=60,
                           creationflags=SEM_JANELA)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def ler_cfg() -> dict:
    try:
        return json.loads(CFG_ARQ.read_text(encoding="utf-8"))
    except Exception:
        return {}


def salvar_cfg(c: dict) -> None:
    try:
        CFG_ARQ.write_text(json.dumps(c, indent=2, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def python_console() -> str:
    """python.exe ao lado do interpretador atual (o launcher roda em pythonw.exe, sem console)."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        return str(exe.parent / "python.exe")
    return str(exe)


def ip_servidor() -> str:
    try:
        return HOST_TXT.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


PASTA_PADRAO = r"C:\Games\THE DAY BEFORE"
EXE_REL = Path("Survival") / "Binaries" / "Win64" / "TheDayBefore.exe"


def raiz_do_jogo(pasta: str):
    """Aceita a pasta do jogo ou qualquer subpasta dela (ou o proprio .exe) e devolve a raiz (a que tem Survival\Binaries\Win64\
    TheDayBefore.exe), ou None se nao achar."""
    if not pasta:
        return None
    try:
        p = Path(pasta).resolve()
    except OSError:
        return None
    if p.is_file():
        p = p.parent
    for cand in [p, *p.parents]:
        if (cand / EXE_REL).is_file():
            return str(cand)
    return None


def porta_aberta(host: str, porta: int, timeout: float = 3) -> bool:
    try:
        with socket.create_connection((host, porta), timeout):
            return True
    except OSError:
        return False


def pids_escutando(portas: set) -> set:
    """PIDs com socket TCP em LISTENING nas portas dadas (netstat do Windows)."""
    r = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, creationflags=SEM_JANELA).stdout
    r += subprocess.run(["netstat", "-ano", "-p", "TCPv6"], capture_output=True, text=True, creationflags=SEM_JANELA).stdout
    pids = set()
    for linha in r.splitlines():
        p = linha.split()
        if len(p) >= 5 and p[3].upper() == "LISTENING":
            try:
                porta = int(p[1].rsplit(":", 1)[1])
            except (ValueError, IndexError):
                continue
            if porta in portas:
                pids.add(int(p[4]))
    return pids


def imagem_do_pid(pid: int) -> str:
    r = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"], capture_output=True, text=True,
                       creationflags=SEM_JANELA).stdout.strip()
    return r.split('","')[0].strip('"').lower() if r.startswith('"') else ""


def matar(pid: int) -> None:
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=SEM_JANELA)


class Launcher:
    def __init__(self, raiz: tk.Tk):
        self.r = raiz
        self.cfg = ler_cfg()
        self.idioma = self.cfg.get("idioma") if self.cfg.get("idioma") in idiomas.CODIGOS else idiomas.detectar()
        # ultimo texto (chave + valores) de cada rotulo que muda sozinho: permite repintar ao trocar de idioma
        self._ult = {"estado": ("estado_pronto", {}), "servidor": ("srv_verificando", {}),
                     "versao": ("versao", {"v": atualizador.versao_local()})}
        self.repo = self.cfg.get("repo", atualizador.REPO_PADRAO)
        self.fila = queue.Queue()
        self.proc_cliente = None
        self.proc_host = None
        self.modo = None             # "online" / "offline" / None
        self.pid_jogo = None
        self.info_atualizacao = None
        self.parando = False
        self._montar()
        self.r.after(100, self._drenar)
        raiz.report_callback_exception = lambda tp, ex, tb: self.erro("err_janela", ex)
        threading.Thread(target=self._checar_servidor_laco, daemon=True).start()
        self._rodar("verificar atualizacao", self._checar_atualizacao, limpar=False)
        self._rodar("diagnostico", self._diagnostico, limpar=False)

    # ------------------------------------------------------------------ interface
    def _montar(self):
        r = self.r
        r.title("TDB Launcher")
        r.geometry("980x700")
        r.minsize(820, 620)

        # ÐÐ°Ð»Ð¸ÑÑÐ°: ÑÑÐ¼Ð½ÑÐ¹ Ð¸Ð³ÑÐ¾Ð²Ð¾Ð¹ Ð¸Ð½ÑÐµÑÑÐµÐ¹Ñ Ñ ÑÐ¾Ð»Ð¾Ð´Ð½ÑÐ¼Ð¸ Ð°ÐºÑÐµÐ½ÑÐ°Ð¼Ð¸
        bg = "#090D14"
        panel = "#111925"
        panel2 = "#172333"
        border = "#26364A"
        white = "#F2F6FC"
        muted = "#91A2B8"
        accent = "#B7F36B"
        blue = "#67B7FF"
        green = "#A9E86A"
        r.configure(bg=bg)

        def card(parent, color=panel, padx=18, pady=16):
            frame = tk.Frame(parent, bg=color, highlightthickness=1,
                             highlightbackground=border, bd=0)
            frame.configure(padx=padx, pady=pady)
            return frame

        def label(parent, text, size=10, color=muted, bold=False, **kwargs):
            return tk.Label(parent, text=text, bg=parent.cget("bg"), fg=color,
                            font=("Segoe UI", size, "bold" if bold else "normal"),
                            **kwargs)

        # ÐÐµÑÑÐ½ÑÑ Ð¿Ð°Ð½ÐµÐ»Ñ
        top = tk.Frame(r, bg=bg)
        top.pack(fill="x", padx=30, pady=(24, 18))
        brand = tk.Frame(top, bg=bg)
        brand.pack(side="left", fill="x", expand=True)
        mark = tk.Label(brand, text="TDB", bg=accent, fg="#10170A",
                        font=("Segoe UI", 13, "bold"), padx=11, pady=7)
        mark.pack(side="left", padx=(0, 13))
        heading = tk.Frame(brand, bg=bg)
        heading.pack(side="left", anchor="w")
        self.w_titulo = tk.Label(heading, text=self.t("titulo"), bg=bg, fg=white,
                                 font=("Segoe UI", 17, "bold"), anchor="w")
        self.w_titulo.pack(anchor="w")
        label(heading, "COMMUNITY EDITION  â¢  THE DAY BEFORE", 8, muted, True).pack(anchor="w", pady=(3, 0))

        langbox = tk.Frame(top, bg=panel, highlightthickness=1, highlightbackground=border)
        langbox.pack(side="right", padx=(12, 0))
        self.lbl_idioma = tk.Label(langbox, text=self.t("idioma"), bg=panel, fg=muted,
                                   font=("Segoe UI", 9))
        self.lbl_idioma.pack(side="left", padx=(12, 5), pady=8)
        self.v_idioma = tk.StringVar(value=idiomas.NOMES[self.idioma])
        menu = tk.OptionMenu(langbox, self.v_idioma, *idiomas.NOMES.values(), command=self._trocar_idioma)
        menu.configure(bg=panel2, fg=white, activebackground="#26384D", activeforeground=white,
                       relief="flat", highlightthickness=0, bd=0, font=("Segoe UI", 9, "bold"),
                       cursor="hand2", padx=7, pady=4)
        menu["menu"].configure(bg=panel2, fg=white, activebackground="#31465E",
                               activeforeground=white, relief="flat", font=("Segoe UI", 9))
        menu.pack(side="left", padx=(0, 8), pady=6)



        # Ð¡ÑÐ°ÑÑÑÐ½ÑÐµ ÐºÐ°ÑÑÐ¾ÑÐºÐ¸
        statuses = tk.Frame(r, bg=bg)
        statuses.pack(fill="x", padx=30, pady=(0, 16))
        statuses.columnconfigure(0, weight=1)
        statuses.columnconfigure(1, weight=1)
        server_card = card(statuses, panel, 15, 12)
        server_card.grid(row=0, column=0, sticky="nsew", padx=(0, 7))
        version_card = card(statuses, panel, 15, 12)
        version_card.grid(row=0, column=1, sticky="nsew", padx=(7, 0))
        label(server_card, "â  SERVER STATUS", 8, green, True).pack(anchor="w")
        self.lbl_servidor = tk.Label(server_card, text=self.t("srv_verificando"), bg=panel,
                                     fg=white, font=("Segoe UI", 10, "bold"), anchor="w")
        self.lbl_servidor.pack(anchor="w", pady=(7, 0))
        label(version_card, "â»  LAUNCHER VERSION", 8, blue, True).pack(anchor="w")
        self.lbl_versao = tk.Label(version_card,
                                   text=self.t("versao", v=atualizador.versao_local()),
                                   bg=panel, fg=white, font=("Segoe UI", 10, "bold"), anchor="w")
        self.lbl_versao.pack(anchor="w", pady=(7, 0))

        # Ð¦ÐµÐ½ÑÑÐ°Ð»ÑÐ½Ð°Ñ Ð¾Ð±Ð»Ð°ÑÑÑ: Ð·Ð°Ð¿ÑÑÐº Ð¸ Ð½Ð°ÑÑÑÐ¾Ð¹ÐºÐ¸
        content = tk.Frame(r, bg=bg)
        content.pack(fill="x", padx=30, pady=(0, 14))
        play = card(content, panel, 18, 15)
        play.pack(side="left", fill="both", expand=True, padx=(0, 8))
        settings = card(content, panel, 16, 15)
        settings.pack(side="left", fill="both", expand=True, padx=(8, 0))
        label(play, "CHOOSE YOUR EXPERIENCE", 8, muted, True).pack(anchor="w", pady=(0, 12))

        buttons = tk.Frame(play, bg=panel)
        buttons.pack(fill="x")
        def game_button(parent, text, color, hover, command):
            b = tk.Button(parent, text=text, bg=color, fg="#101820",
                          activebackground=hover, activeforeground="#101820",
                          command=command, relief="flat", bd=0, cursor="hand2",
                          font=("Segoe UI", 11, "bold"), padx=14, pady=13)
            return b
        self.b_online = game_button(buttons, self.t("b_online"), accent, "#C9FF8B", self.jogar_online)
        self.b_online.pack(side="left", fill="x", expand=True, padx=(0, 5))
        self.b_offline = game_button(buttons, self.t("b_offline"), "#6DBBFF", "#91CEFF", self.jogar_offline)
        self.b_offline.pack(side="left", fill="x", expand=True, padx=(5, 0))
        self.lbl_estado = tk.Label(play, text=self.t("estado_pronto"), bg=panel, fg=green,
                                   font=("Segoe UI", 9, "bold"), anchor="w")
        self.lbl_estado.pack(anchor="w", pady=(13, 0))

        label(settings, "GAME SETTINGS", 8, muted, True).pack(anchor="w", pady=(0, 10))
        self.w_pasta = tk.Label(settings, text=self.t("w_pasta"), bg=panel, fg=white,
                                font=("Segoe UI", 9, "bold"), anchor="w")
        self.w_pasta.pack(anchor="w")
        pathrow = tk.Frame(settings, bg=panel)
        pathrow.pack(fill="x", pady=(5, 10))
        self.lbl_pasta = tk.Label(pathrow, text="", bg=panel2, fg=white,
                                  font=("Segoe UI", 8), anchor="w", justify="left",
                                  wraplength=260, padx=9, pady=8)
        self.lbl_pasta.pack(side="left", fill="x", expand=True)
        self.b_escolher = tk.Button(pathrow, text=self.t("b_escolher"), command=self.escolher_pasta,
                                    bg="#26384D", fg=white, activebackground="#354B63",
                                    activeforeground=white, relief="flat", bd=0,
                                    font=("Segoe UI", 8, "bold"), padx=10, pady=8, cursor="hand2")
        self.b_escolher.pack(side="right", padx=(7, 0))
        self.v_barras = tk.BooleanVar(value=self.cfg.get("barras_fixas", True))
        self.chk_barras = tk.Checkbutton(settings, text=self.t("chk_barras"),
                                         variable=self.v_barras, bg=panel, fg=muted,
                                         selectcolor=panel2, activebackground=panel,
                                         activeforeground=white, command=self._salvar_opcoes,
                                         font=("Segoe UI", 9), anchor="w")
        self.chk_barras.pack(anchor="w")

        # ÐÐ¸Ð¶Ð½ÑÑ Ð¿Ð°Ð½ÐµÐ»Ñ Ð¸Ð½ÑÑÑÑÐ¼ÐµÐ½ÑÐ¾Ð²
        tools = tk.Frame(r, bg=bg)
        tools.pack(fill="x", padx=30, pady=(0, 10))
        toolstyle = dict(bg="#1A2736", fg="#C7D3E1", activebackground="#2A3C51",
                         activeforeground=white, relief="flat", bd=0,
                         font=("Segoe UI", 9, "bold"), padx=12, pady=8, cursor="hand2")
        self.b_parar = tk.Button(tools, text=self.t("b_parar"), command=self.parar,
                                 state="disabled", **toolstyle)
        self.b_parar.pack(side="left")
        self.b_atualizar = tk.Button(tools, text=self.t("b_atualizar"),
                                     command=self.atualizar_manual, **toolstyle)
        self.b_atualizar.pack(side="left", padx=(7, 0))
        self.b_log = tk.Button(tools, text=self.t("b_log"), command=self.abrir_log_launcher, **toolstyle)
        self.b_log.pack(side="left", padx=(7, 0))
        label(tools, "TDB COMMUNITY LAUNCHER", 8, "#52657B", True).pack(side="right", pady=10)

        # ÐÐ¾Ð½ÑÐ¾Ð»Ñ Ð»Ð¾Ð³Ð¾Ð²
        logs = card(r, "#0D141E", 12, 10)
        logs.pack(fill="both", expand=True, padx=30, pady=(0, 22))
        loghead = tk.Frame(logs, bg="#0D141E")
        loghead.pack(fill="x", pady=(0, 7))
        tk.Label(loghead, text="SYSTEM CONSOLE", bg="#0D141E", fg=muted,
                 font=("Segoe UI", 8, "bold")).pack(side="left")
        tk.Label(loghead, text="â LIVE", bg="#0D141E", fg=green,
                 font=("Segoe UI", 8, "bold")).pack(side="right")
        self.txt = scrolledtext.ScrolledText(logs, bg="#0A1018", fg="#AFC2D8",
                                             insertbackground=white, font=("Cascadia Mono", 8),
                                             relief="flat", bd=0, height=7,
                                             padx=10, pady=8, wrap="word")
        self.txt.pack(fill="both", expand=True)
        self.txt.configure(state="disabled")
        r.protocol("WM_DELETE_WINDOW", self.fechar)
        self._mostrar_pasta()

    def _diagnostico(self):
        py = python_console()
        gravar_log("=" * 60)
        self.logk("diag", v=atualizador.versao_local(), py_ver=sys.version.split()[0], py=py, pasta=self.pasta_jogo() or "-")
        v = frida_instalado(py)
        if v:
            self.logk("frida_ok", v=v)
        else:
            self.logk("frida_falta")
            self.fila.put(("aviso", self.t("dlg_frida", py=py)))

    def _salvar_opcoes(self):
        self.cfg["barras_fixas"] = bool(self.v_barras.get()); salvar_cfg(self.cfg)

    def t(self, chave: str, **kw) -> str:
        return idiomas.tr(self.idioma, chave, **kw)

    def log(self, msg: str):
        linha = time.strftime("%H:%M:%S ") + msg
        gravar_log(linha)
        self.fila.put(("log", linha))

    def logk(self, chave: str, **kw):
        """Mensagem do launcher: na janela, no idioma escolhido; no launcher.log, sempre em portugues (o dono le esse arquivo)."""
        hora = time.strftime("%H:%M:%S ")
        gravar_log(hora + idiomas.tr("pt", chave, **kw))
        self.fila.put(("log", hora + self.t(chave, **kw)))

    def erro(self, chave: str, exc: BaseException = None, **kw):
        """Registra um erro com o traceback completo (janela + launcher.log) e mostra um aviso."""
        detalhe = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)) if exc else ""
        hora = time.strftime("%H:%M:%S ")
        resto = (": %s" % exc) if exc else ""
        gravar_log(hora + "ERRO: " + idiomas.tr("pt", chave, **kw) + resto)
        self.fila.put(("log", hora + "ERRO: " + self.t(chave, **kw) + resto))
        for l in detalhe.rstrip().splitlines():
            self.log("    " + l)
        self.fila.put(("aviso", self.t("erro_aviso", titulo=self.t(chave, **kw), exc=exc or "", log=LOG_LAUNCHER)))

    # ------------------------------------------------------------------ idioma
    def _pintar(self, tipo: str):
        chave, kw = self._ult[tipo]
        {"estado": self.lbl_estado, "servidor": self.lbl_servidor, "versao": self.lbl_versao}[tipo].configure(text=self.t(chave, **kw))

    def _trocar_idioma(self, nome: str):
        for cod, n in idiomas.NOMES.items():
            if n == nome:
                self.idioma = cod
        self.cfg["idioma"] = self.idioma; salvar_cfg(self.cfg)
        self._aplicar_idioma()

    def _aplicar_idioma(self):
        self.w_titulo.configure(text=self.t("titulo"))
        self.lbl_idioma.configure(text=self.t("idioma"))
        self.b_online.configure(text=self.t("b_online"))
        self.b_offline.configure(text=self.t("b_offline"))
        self.b_parar.configure(text=self.t("b_parar"))
        self.b_atualizar.configure(text=self.t("b_atualizar"))
        self.b_log.configure(text=self.t("b_log"))
        self.w_pasta.configure(text=self.t("w_pasta"))
        self.b_escolher.configure(text=self.t("b_escolher"))
        self.chk_barras.configure(text=self.t("chk_barras"))
        self._mostrar_pasta()
        for tipo in ("estado", "servidor", "versao"):
            self._pintar(tipo)

    def _rodar(self, nome: str, fn, limpar=True):
        """Roda fn numa thread; qualquer excecao vira erro visivel e, se for um fluxo de jogo, o launcher volta ao estado Pronto."""
        def alvo():
            try:
                fn()
            except Exception as e:
                self.erro("err_falha", e, nome=nome)
                if limpar and self.modo:
                    try:
                        self._encerrar_processos(rapido=True)
                    except Exception as e2:
                        self.erro("err_encerrar", e2)
                    self._fim()
        threading.Thread(target=alvo, daemon=True, name=nome).start()

    def estado(self, chave: str, **kw):
        self.fila.put(("estado", (chave, kw)))

    def _drenar(self):
        try:
            while True:
                tipo, val = self.fila.get_nowait()
                if tipo == "log":
                    self.txt.configure(state="normal"); self.txt.insert("end", val + "\n")
                    if int(self.txt.index("end-1c").split(".")[0]) > 3000:
                        self.txt.delete("1.0", "500.0")
                    self.txt.see("end"); self.txt.configure(state="disabled")
                elif tipo in ("estado", "servidor", "versao"):
                    self._ult[tipo] = val; self._pintar(tipo)
                elif tipo == "botoes":
                    self._botoes(val)
                elif tipo == "reiniciar":
                    self._reiniciar_launcher()
                elif tipo == "aviso":
                    messagebox.showerror("TDB Launcher", val, parent=self.r)
        except queue.Empty:
            pass
        self.r.after(100, self._drenar)

    def _botoes(self, jogando: bool):
        self.b_online.configure(state="disabled" if jogando else "normal")
        self.b_offline.configure(state="disabled" if jogando else "normal")
        self.b_atualizar.configure(state="disabled" if jogando else "normal")
        self.b_parar.configure(state="normal" if jogando else "disabled")

    # ------------------------------------------------------------------ servidor / atualizacao
    def _checar_servidor_laco(self):
        while True:
            ip = ip_servidor()
            if not ip:
                self.fila.put(("servidor", ("srv_sem_host", {})))
            else:
                ok = porta_aberta(ip, 443)
                self.fila.put(("servidor", ("srv_no_ar" if ok else "srv_fora", {"ip": ip})))
            time.sleep(30)

    def _checar_atualizacao(self, aplicar_se_houver=False):
        info = atualizador.verificar(self.repo)
        if not info["ok"]:
            self.fila.put(("versao", ("versao_nao_verif", {"v": atualizador.versao_local()})))
            self.logk("upd_msg", e=info["erro"])
            return None
        self.info_atualizacao = info
        if info.get("aviso"):
            self.logk("upd_msg", e=info["aviso"])
        if info["pendentes"]:
            self.fila.put(("versao", ("versao_pend", {"v": atualizador.versao_local(), "n": info["versao"], "c": len(info["pendentes"])})))
            self.logk("upd_disp", n=info["versao"], arqs=", ".join(info["pendentes"][:8]) + (" ..." if len(info["pendentes"]) > 8 else ""))
            if info.get("notas"):
                self.logk("upd_notas", n=info["notas"])
        else:
            if atualizador.versao_local() != info["versao"]:
                try: atualizador.ARQ_VERSAO.write_text(info["versao"] + "\n", encoding="utf-8")
                except OSError: pass
            self.fila.put(("versao", ("versao_atual", {"v": info["versao"]})))
        return info

    def _aplicar_atualizacao(self) -> bool:
        """Aplica a atualizacao pendente (se houver). Devolve False se o launcher precisa reabrir (nao seguir para o jogo)."""
        info = self.info_atualizacao or self._checar_atualizacao()
        if not info or not info.get("pendentes"):
            return True
        self.estado("estado_atualizando", n=info["versao"])
        try:
            gravados = atualizador.aplicar(info, self.repo, log=self.log)
        except Exception as e:
            self.logk("upd_falha", e=e)
            return True
        self.info_atualizacao = None
        self.fila.put(("versao", ("versao_atual", {"v": info["versao"]})))
        if any(g.startswith("launcher/") for g in gravados):
            self.logk("upd_reabrir")
            self.fila.put(("reiniciar", None))
            return False
        return True

    def atualizar_manual(self):
        def t():
            self.estado("estado_procurando")
            info = self._checar_atualizacao()
            if info and info["pendentes"]:
                if self._aplicar_atualizacao():
                    self.estado("estado_atualizado")
            elif info:
                self.estado("estado_ja_recente")
            else:
                self.estado("estado_nao_verif")
        self._rodar("procurar atualizacao", t, limpar=False)

    def _reiniciar_launcher(self):
        subprocess.Popen([sys.executable, "-I", str(AQUI / "tdb_launcher.py")], cwd=str(RAIZ))
        self.r.destroy()

    # ------------------------------------------------------------------ processos
    def _ler_saida(self, proc, prefixo, ao_ler=None):
        for b in iter(proc.stdout.readline, b""):
            linha = b.decode("utf-8", "replace").rstrip()
            if not linha:
                continue
            m = re.search(r"cliente pid=(\d+)", linha)
            if m:
                self.pid_jogo = int(m.group(1))
            if ao_ler:
                ao_ler(linha)
            self.log(prefixo + linha)

    def _args_cliente(self, local: bool) -> list:
        a = [python_console(), "-I", "-X", "utf8", str(CLIENTE)]
        if local:
            a.append("--local")
        if not self.v_barras.get():
            a.append("--sem-barras-fixas")
        return a

    def _env(self) -> dict:
        env = dict(os.environ)
        pasta = self.pasta_jogo()
        if pasta:
            env["TDB_JOGO"] = pasta   # lida pelo cliente_conecta.py e pelo servidor_host.py
        return env

    # ------------------------------------------------------------------ pasta do jogo
    def pasta_jogo(self):
        """Pasta escolhida (config.json) se for valida; senao a padrao, se existir; senao None."""
        return raiz_do_jogo(self.cfg.get("pasta_jogo", "")) or raiz_do_jogo(os.environ.get("TDB_JOGO", "")) or raiz_do_jogo(PASTA_PADRAO)

    def _mostrar_pasta(self):
        p = self.pasta_jogo()
        if p:
            self.lbl_pasta.configure(text=p, fg="#e6e6e6")
        else:
            self.lbl_pasta.configure(text=self.t("pasta_nao_achada"), fg="#e0a050")

    def escolher_pasta(self) -> bool:
        inicial = self.pasta_jogo() or (str(Path(self.cfg["pasta_jogo"]).parent) if self.cfg.get("pasta_jogo") else "C:\\")
        escolhida = filedialog.askdirectory(title=self.t("dlg_pasta_titulo"), initialdir=inicial,
                                            mustexist=True, parent=self.r)
        if not escolhida:
            return False
        raiz = raiz_do_jogo(escolhida)
        if not raiz:
            messagebox.showerror("TDB Launcher", self.t("dlg_pasta_invalida"), parent=self.r)
            return False
        self.cfg["pasta_jogo"] = raiz; salvar_cfg(self.cfg)
        self._mostrar_pasta()
        self.logk("pasta_log", p=raiz)
        return True

    def _conferir_pasta(self) -> bool:
        """Antes de jogar: exige uma pasta valida (abre o seletor se faltar)."""
        if self.pasta_jogo():
            return True
        messagebox.showinfo("TDB Launcher", self.t("dlg_primeiro"), parent=self.r)
        return self.escolher_pasta()

    def _iniciar_cliente(self, local: bool):
        self.proc_cliente = subprocess.Popen(self._args_cliente(local), cwd=str(CLIENTE.parent), stdout=subprocess.PIPE,
                                             stderr=subprocess.STDOUT, creationflags=SEM_JANELA, env=self._env())
        threading.Thread(target=self._ler_saida, args=(self.proc_cliente, ""), daemon=True).start()

    def jogar_online(self):
        if not ip_servidor():
            messagebox.showwarning("TDB Launcher", self.t("dlg_falta_hosttxt")); return
        if not self._conferir_pasta():
            return
        self.modo = "online"; self.fila.put(("botoes", True))

        def t():
            if not self._aplicar_atualizacao():
                return
            if pids_escutando({443}):
                self.logk("aviso_443")
            self.estado("estado_online", ip=ip_servidor())
            self._iniciar_cliente(local=False)
            self.proc_cliente.wait()
            self.logk("jogo_fechado")
            self._fim()
        self._rodar("jogar online", t)

    def jogar_offline(self):
        if not HOST.exists():
            messagebox.showwarning("TDB Launcher", self.t("dlg_falta_host")); return
        if not self._conferir_pasta():
            return
        self.modo = "offline"; self.fila.put(("botoes", True))

        def t():
            if not self._aplicar_atualizacao():
                return
            self.estado("estado_subindo")
            try:
                if LOG_HOST.exists():
                    os.replace(LOG_HOST, LOG_HOST.with_name(LOG_HOST.name + ".anterior"))
            except OSError:
                pass
            host = HOST_OTIM if HOST_OTIM.exists() else HOST
            self.log("host: %s %s" % (host.parent.name, " ".join(ARGS_HOST_OFFLINE)))
            self.proc_host = subprocess.Popen([python_console(), "-I", "-X", "utf8", str(host)] + ARGS_HOST_OFFLINE, cwd=str(host.parent),
                                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=SEM_JANELA, env=self._env())
            threading.Thread(target=self._ler_saida, args=(self.proc_host, "[host] "), daemon=True).start()
            fim = time.time() + 420
            pronto = False
            while time.time() < fim and not self.parando:
                if self.proc_host.poll() is not None:
                    break
                try:
                    if "[lnat] LISTEN OK" in LOG_HOST.read_text(encoding="utf-8", errors="replace"):
                        pronto = True; break
                except OSError:
                    pass
                time.sleep(2)
            if not pronto:
                if not self.parando:
                    self.logk("host_falhou", f=LOG_HOST)
                self._parar_offline(rapido=True); self._fim(); return
            self.logk("host_pronto")
            self.estado("estado_offline")
            self._iniciar_cliente(local=True)
            self.proc_cliente.wait()
            self.logk("jogo_fechado")
            self._parar_offline(rapido=self.parando)
            self._fim()
        self._rodar("jogar offline", t)

    def _pid_host(self):
        try:
            m = re.findall(r"HOST PID (\d+)", LOG_HOST.read_text(encoding="utf-8", errors="replace"))
            return int(m[-1]) if m else None
        except OSError:
            return None

    def _parar_offline(self, rapido=False):
        self.estado("estado_fechando")
        pid = self._pid_host()
        if pid and imagem_do_pid(pid) == "thedaybefore.exe":
            matar(pid); self.logk("host_fechado", pid=pid)
        if self.proc_host and self.proc_host.poll() is None:
            try:
                self.proc_host.wait(timeout=45 if rapido else 150)   # o runner faz o export final do Firestore ao sair
            except subprocess.TimeoutExpired:
                self.logk("runner_forca")
                matar(self.proc_host.pid)
        # servicos locais (emulador do Firestore, ponte IPv6, terminador TLS) ficam soltos depois do runner: desliga
        for p in pids_escutando({443, 8081, 4400, 4500, 9150}):
            img = imagem_do_pid(p)
            if img in IMAGENS_SERVICO:
                matar(p); self.logk("servico_off", img=img, pid=p)
        self.proc_host = None

    def _encerrar_processos(self, rapido=True):
        """Fecha o jogo e o cliente na hora; no Offline, fecha tambem o host local e os servicos."""
        if self.pid_jogo and imagem_do_pid(self.pid_jogo) == "thedaybefore.exe":
            matar(self.pid_jogo); self.logk("jogo_fechado_pid", pid=self.pid_jogo)
        if self.proc_cliente and self.proc_cliente.poll() is None:
            matar(self.proc_cliente.pid)
        if self.proc_host is not None:
            self._parar_offline(rapido=rapido)

    def _fim(self):
        self.modo = None; self.pid_jogo = None; self.proc_cliente = None; self.parando = False
        self.fila.put(("botoes", False))
        self.estado("estado_pronto")

    def parar(self):
        if not self.modo:
            return
        self.parando = True
        self.estado("estado_parando")

        def t():
            # fecha o jogo e o cliente na hora; o fluxo de jogo (jogar_*) percebe e faz o resto (fecha o host no Offline e volta a Pronto)
            if self.pid_jogo and imagem_do_pid(self.pid_jogo) == "thedaybefore.exe":
                matar(self.pid_jogo); self.logk("jogo_fechado_pid", pid=self.pid_jogo)
            if self.proc_cliente and self.proc_cliente.poll() is None:
                matar(self.proc_cliente.pid)
            # vigia: se o fluxo de jogo nao voltar sozinho (travado ou morto), encerra tudo e destrava
            fim = time.time() + 75
            while self.modo and time.time() < fim:
                time.sleep(0.5)
            if self.modo:
                self.logk("forca_tudo")
                self._encerrar_processos(rapido=True)
                self._fim()
        self._rodar("parar", t, limpar=False)

    def abrir_logs(self):
        os.startfile(str(CLIENTE.parent))

    def abrir_log_launcher(self):
        gravar_log("")
        os.startfile(str(LOG_LAUNCHER))

    def fechar(self):
        if self.modo:
            if not messagebox.askyesno("TDB Launcher", self.t("dlg_fechar_off" if self.modo == "offline" else "dlg_fechar_on")):
                return
            self.parar()
            def esperar():
                while self.modo:
                    time.sleep(0.5)
                self.r.after(0, self.r.destroy)
            threading.Thread(target=esperar, daemon=True).start()
            return
        self.r.destroy()


def main():
    raiz = tk.Tk()
    Launcher(raiz)
    if "--teste-janela" in sys.argv:          # abre e fecha sozinho (usado para conferir que a janela monta)
        raiz.after(int(sys.argv[sys.argv.index("--teste-janela") + 1]) if len(sys.argv) > sys.argv.index("--teste-janela") + 1 else 3000, raiz.destroy)
    raiz.mainloop()


if __name__ == "__main__":
    main()
