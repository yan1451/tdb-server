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
import diagnostico  # noqa: E402

CFG_ARQ = AQUI / "config.json"
CLIENTE = RAIZ / "cliente" / "cliente_conecta.py"
RESOLUCOES = ("1280x720", "1366x768", "1600x900", "1920x1080", "2560x1440", "3840x2160")
HOST = RAIZ / "host" / "servidor_host.py"
# 10/11: o Offline usa o host_otimizado (replicacao em C, sem o limite de 150 atores sempre relevantes) com os mesmos argumentos
# da VPS. O host normal (replicacao em JS a cada quadro + monitores) rodava a 9-15 quadros/s com 1 jogador: atraso e itens demorando.
HOST_OTIM = RAIZ / "host_otimizado" / "servidor_host.py"
ARGS_HOST_OFFLINE = ["--appdata-separado", "--sem-monitores"]   # 10/11: resgate de queda (resgate_queda.js) ligado dentro do host
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
        r.geometry("760x520")
        r.minsize(620, 420)
        fundo, texto, sec = "#15181d", "#e6e6e6", "#9aa3ad"
        r.configure(bg=fundo)
        self.w_titulo = tk.Label(r, text=self.t("titulo"), bg=fundo, fg=texto, font=("Segoe UI", 15, "bold"))
        self.w_titulo.pack(anchor="w", padx=16, pady=(14, 2))
        info = tk.Frame(r, bg=fundo); info.pack(fill="x", padx=16)
        self.lbl_servidor = tk.Label(info, text=self.t("srv_verificando"), bg=fundo, fg=sec, font=("Segoe UI", 10))
        self.lbl_servidor.grid(row=0, column=0, sticky="w")
        self.lbl_versao = tk.Label(info, text=self.t("versao", v=atualizador.versao_local()), bg=fundo, fg=sec, font=("Segoe UI", 10))
        self.lbl_versao.grid(row=1, column=0, sticky="w")
        self.lbl_estado = tk.Label(info, text=self.t("estado_pronto"), bg=fundo, fg=texto, font=("Segoe UI", 10, "bold"))
        self.lbl_estado.grid(row=2, column=0, sticky="w", pady=(4, 0))

        info.columnconfigure(0, weight=1)
        self.lbl_idioma = tk.Label(info, text=self.t("idioma"), bg=fundo, fg=sec, font=("Segoe UI", 10))
        self.lbl_idioma.grid(row=0, column=1, sticky="e", padx=(0, 6))
        self.v_idioma = tk.StringVar(value=idiomas.NOMES[self.idioma])
        menu = tk.OptionMenu(info, self.v_idioma, *idiomas.NOMES.values(), command=self._trocar_idioma)
        menu.configure(bg="#2a2f37", fg=texto, activebackground="#363c46", activeforeground=texto, relief="flat", highlightthickness=0,
                       bd=0, font=("Segoe UI", 10), cursor="hand2")
        menu["menu"].configure(bg="#2a2f37", fg=texto, activebackground="#363c46", activeforeground=texto, font=("Segoe UI", 10))
        menu.grid(row=0, column=2, sticky="e")

        bot = tk.Frame(r, bg=fundo); bot.pack(fill="x", padx=16, pady=10)
        estilo = dict(font=("Segoe UI", 11, "bold"), relief="flat", padx=14, pady=8, cursor="hand2", bd=0)
        self.b_online = tk.Button(bot, text=self.t("b_online"), bg="#2f7d4f", fg="white", activebackground="#3a9a61", command=self.jogar_online, **estilo)
        self.b_online.pack(side="left")
        self.b_offline = tk.Button(bot, text=self.t("b_offline"), bg="#3b5b8a", fg="white", activebackground="#4a70a8", command=self.jogar_offline, **estilo)
        self.b_offline.pack(side="left", padx=8)
        estilo2 = dict(font=("Segoe UI", 10), relief="flat", padx=10, pady=8, cursor="hand2", bd=0, bg="#2a2f37", fg=texto, activebackground="#363c46")
        self.b_parar = tk.Button(bot, text=self.t("b_parar"), command=self.parar, state="disabled", **estilo2)
        self.b_parar.pack(side="left")
        self.b_atualizar = tk.Button(bot, text=self.t("b_atualizar"), command=self.atualizar_manual, **estilo2)
        self.b_atualizar.pack(side="left", padx=8)
        self.b_log = tk.Button(bot, text=self.t("b_log"), command=self.abrir_log_launcher, **estilo2)
        self.b_log.pack(side="left")

        jog = tk.Frame(r, bg=fundo); jog.pack(fill="x", padx=16, pady=(0, 6))
        self.w_pasta = tk.Label(jog, text=self.t("w_pasta"), bg=fundo, fg=sec, font=("Segoe UI", 10))
        self.w_pasta.pack(side="left")
        self.lbl_pasta = tk.Label(jog, text="", bg=fundo, fg=texto, font=("Segoe UI", 10), anchor="w")
        self.lbl_pasta.pack(side="left", padx=(6, 8), fill="x", expand=True)
        self.b_escolher = tk.Button(jog, text=self.t("b_escolher"), command=self.escolher_pasta, **estilo2)
        self.b_escolher.pack(side="right")
        self._mostrar_pasta()

        opc = tk.Frame(r, bg=fundo); opc.pack(fill="x", padx=16)
        self.v_barras = tk.BooleanVar(value=self.cfg.get("barras_fixas", True))
        self.chk_barras = tk.Checkbutton(opc, text=self.t("chk_barras"), variable=self.v_barras, bg=fundo, fg=sec, selectcolor="#2a2f37",
                                         activebackground=fundo, activeforeground=texto, command=self._salvar_opcoes)
        self.chk_barras.pack(side="left")
        self.b_diag = tk.Button(opc, text=self.t("b_diag"), command=self.gerar_diag, **estilo2)   # 12/11: junta logs e estado do save num .zip
        self.b_diag.pack(side="right")

        # 12/11: o jogo era aberto sempre em janela 1280x720 (-windowed -ResX=1280 -ResY=720) e a pessoa ficava presa nessa tela: agora escolhe o modo e a resolucao
        tela = tk.Frame(r, bg=fundo); tela.pack(fill="x", padx=16, pady=(6, 0))
        self.w_tela = tk.Label(tela, text=self.t("w_tela"), bg=fundo, fg=sec, font=("Segoe UI", 10)); self.w_tela.pack(side="left")
        self.v_tela_modo = tk.StringVar()
        self.menu_modo = tk.OptionMenu(tela, self.v_tela_modo, "")
        self.w_res = tk.Label(tela, text=self.t("w_res"), bg=fundo, fg=sec, font=("Segoe UI", 10))
        self.v_tela_res = tk.StringVar()
        self.menu_res = tk.OptionMenu(tela, self.v_tela_res, "")
        for m in (self.menu_modo, self.menu_res):
            m.configure(bg="#2a2f37", fg=texto, activebackground="#363c46", activeforeground=texto, relief="flat", highlightthickness=0, bd=0, font=("Segoe UI", 10), cursor="hand2")
            m["menu"].configure(bg="#2a2f37", fg=texto, activebackground="#363c46", activeforeground=texto, font=("Segoe UI", 10))
        self.menu_modo.pack(side="left", padx=(6, 18)); self.w_res.pack(side="left"); self.menu_res.pack(side="left", padx=6)
        self._montar_menus_tela()

        self.txt = scrolledtext.ScrolledText(r, bg="#0e1013", fg="#cfd6dd", insertbackground="white", font=("Consolas", 9), relief="flat", height=14)
        self.txt.pack(fill="both", expand=True, padx=16, pady=(8, 14))
        self.txt.configure(state="disabled")
        r.protocol("WM_DELETE_WINDOW", self.fechar)

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

    # ------------------------------------------------------------------ tela (modo e resolucao do jogo)
    def _montar_menus_tela(self):
        modos = {"padrao": self.t("tela_padrao"), "janela": self.t("tela_janela"), "tela_cheia": self.t("tela_cheia")}
        res = {"padrao": self.t("res_padrao"), "monitor": self.t("res_monitor")}
        res.update({r: r.replace("x", " × ") for r in RESOLUCOES})
        for menu, var, tabela, chave in ((self.menu_modo, self.v_tela_modo, modos, "tela_modo"), (self.menu_res, self.v_tela_res, res, "tela_res")):
            atual = self.cfg.get(chave, "padrao")
            if atual not in tabela:
                atual = "padrao"
            var.set(tabela[atual])
            m = menu["menu"]; m.delete(0, "end")
            for cod, txt in tabela.items():
                m.add_command(label=txt, command=lambda c=cod, t=txt, v=var, k=chave: self._escolher_tela(k, c, v, t))

    def _escolher_tela(self, chave: str, cod: str, var, txt: str):
        var.set(txt); self.cfg[chave] = cod; salvar_cfg(self.cfg)

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
        self.b_diag.configure(text=self.t("b_diag"))
        self.w_pasta.configure(text=self.t("w_pasta"))
        self.b_escolher.configure(text=self.t("b_escolher"))
        self.chk_barras.configure(text=self.t("chk_barras"))
        self.w_tela.configure(text=self.t("w_tela")); self.w_res.configure(text=self.t("w_res")); self._montar_menus_tela()
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
                elif tipo == "info":
                    messagebox.showinfo("TDB Launcher", val, parent=self.r)
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
        env["TDB_TELA_MODO"] = self.cfg.get("tela_modo", "padrao")   # padrao | janela | tela_cheia (lido pelo cliente_conecta.py)
        env["TDB_TELA_RES"] = self.cfg.get("tela_res", "padrao")     # padrao | monitor | 1920x1080 ...
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

    def gerar_diag(self):
        """Gera um .zip na Area de Trabalho com logs, versoes e o estado do save local; a pessoa so envia o arquivo."""
        def t():
            try:
                arq = diagnostico.gerar(RAIZ, AQUI, self.cfg)
                self.logk("diag_gerado", arq=str(arq))
                self.fila.put(("info", self.t("dlg_diag_ok", arq=str(arq))))
                try:
                    subprocess.Popen(["explorer", "/select,", str(arq)])
                except Exception:
                    pass
            except Exception as e:
                self.erro("err_diag", e)
        self._rodar("gerar diagnostico", t, limpar=False)

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
