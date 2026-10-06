"""Tkinter tabanlı masaüstü arayüzü.

Çalıştırma: python -m reels_transfer gui
"""
from __future__ import annotations

import os
import hashlib
import json
import platform
import queue
import subprocess
import threading
from datetime import datetime
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk
from urllib.parse import urlparse

from dotenv import set_key
from dotenv import dotenv_values

from .config import ConfigError, Settings, load_settings
from .downloader import DownloadError, download_reel
from .media import MediaError
from .pipeline import run_once
from .publisher import InstagramApiError, InstagramPublisher
from .sources import deduplicate_source_lines, extract_shortcode, load_sources
from .state import StateStore


class ReelsApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Reels Transfer — Instagram Yayın Paneli")
        self.geometry("1180x820")
        self.minsize(980, 700)
        self.configure(bg="#f3f5fa")
        self._events: queue.Queue[tuple[str, object]] = queue.Queue()
        self._worker: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._progress_running = False
        self._log_history: list[str] = []
        self._display_progress = 0.0
        self._target_progress = 0
        self._progress_animation_pending = False
        self.theme_var = tk.StringVar(value=self._load_theme_preference())
        self._build_style()
        self._build_ui()
        self.after(150, self._process_events)
        self._load_existing_env()

    def _build_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("TFrame", background="#f3f5fa")
        style.configure("TLabel", background="#ffffff", foreground="#344054", font=("TkDefaultFont", 10))
        style.configure("Title.TLabel", background="#f3f5fa", font=("TkDefaultFont", 25, "bold"), foreground="#101828")
        style.configure("Subtitle.TLabel", background="#f3f5fa", font=("TkDefaultFont", 10), foreground="#667085")
        style.configure("Card.TLabelframe", background="#ffffff", relief="solid", borderwidth=1)
        style.configure("Card.TLabelframe.Label", background="#ffffff", font=("TkDefaultFont", 11, "bold"), foreground="#344054")
        style.configure("TButton", padding=(12, 8), font=("TkDefaultFont", 9))
        style.configure("Accent.TButton", background="#6c5ce7", foreground="white", font=("TkDefaultFont", 10, "bold"), padding=(15, 10))
        style.map("Accent.TButton", background=[("active", "#5848cf"), ("disabled", "#b9b4e8")])
        style.configure("Status.TLabel", background="#f3f5fa", font=("TkDefaultFont", 10, "bold"), foreground="#475467")
        style.configure("TEntry", padding=7, fieldbackground="#fbfcfe")
        style.configure("Horizontal.TProgressbar", troughcolor="#e9eaf2", background="#6c5ce7", thickness=5)

    def _build_ui(self) -> None:
        root = ttk.Frame(self, padding=24)
        root.pack(fill="both", expand=True)
        header = ttk.Frame(root)
        header.pack(fill="x", pady=(0, 18))
        heading = ttk.Frame(header)
        heading.pack(side="left", fill="x", expand=True)
        ttk.Label(heading, text="REELS TRANSFER", style="Title.TLabel").pack(anchor="w")
        ttk.Label(heading, text="İçerik akışını yönet · sırala · güvenle yayınla", style="Subtitle.TLabel").pack(anchor="w", pady=(3, 0))
        self.activity_dot = tk.Canvas(header, width=18, height=18, bg="#f3f5fa", highlightthickness=0)
        self.activity_dot.pack(side="left", padx=(0, 7))
        self.dot = self.activity_dot.create_oval(4, 4, 14, 14, fill="#12b76a", outline="")
        self.status_label = ttk.Label(header, text="Hazır", style="Status.TLabel")
        self.status_label.pack(side="left")
        ttk.Label(header, text="Tema", style="Subtitle.TLabel").pack(side="left", padx=(18, 5))
        self.theme_picker = ttk.Combobox(header, textvariable=self.theme_var, values=("Açık", "Koyu", "Otomatik"), state="readonly", width=10)
        self.theme_picker.pack(side="left")
        self.theme_picker.bind("<<ComboboxSelected>>", self._change_theme)
        self.progress_ring = tk.Canvas(header, width=62, height=62, bg="#f3f5fa", highlightthickness=0)
        self.progress_ring.pack(side="right", padx=(14, 0))
        self.progress_track = self.progress_ring.create_oval(6, 6, 56, 56, outline="#d9deea", width=5)
        self.progress_arc = self.progress_ring.create_arc(6, 6, 56, 56, start=90, extent=0, style="arc", outline="#6c5ce7", width=5)
        self.progress_text = self.progress_ring.create_text(31, 31, text="0%", fill="#344054", font=("TkDefaultFont", 11, "bold"))
        self.progress = ttk.Progressbar(root, mode="indeterminate", style="Horizontal.TProgressbar")
        self.progress.configure(mode="indeterminate")
        self.progress.pack(fill="x", pady=(0, 14))

        content = ttk.Frame(root)
        content.pack(fill="both", expand=True)
        content.columnconfigure(0, weight=1)
        content.columnconfigure(1, weight=1)
        content.rowconfigure(1, weight=1)

        settings = ttk.LabelFrame(content, text="Instagram ayarları", style="Card.TLabelframe", padding=14)
        settings.grid(row=0, column=0, sticky="nsew", padx=(0, 10), pady=(0, 12))
        settings.columnconfigure(1, weight=1)
        self.token_var = tk.StringVar()
        self.user_id_var = tk.StringVar()
        self.max_posts_var = tk.StringVar(value="3")
        self.poll_seconds_var = tk.StringVar(value="60")
        self.poll_attempts_var = tk.StringVar(value="5")
        self.caption_var = tk.StringVar(value="")
        self.cloud_name_var = tk.StringVar(value="")
        self.upload_preset_var = tk.StringVar(value="")
        self.token_entry = self._field(settings, 0, "Access token", self.token_var, show="*")
        self.reveal_token = tk.BooleanVar(value=False)
        ttk.Checkbutton(settings, text="Tokenı göster", variable=self.reveal_token, command=self._toggle_token).grid(row=0, column=2, sticky="w", padx=(8, 0))
        self._field(settings, 1, "Instagram kullanıcı ID", self.user_id_var)
        self._field(settings, 2, "Tur başına maksimum", self.max_posts_var)
        self._field(settings, 3, "Kontrol aralığı (sn)", self.poll_seconds_var)
        self._field(settings, 4, "Kontrol denemesi", self.poll_attempts_var)
        self._field(settings, 5, "Varsayılan açıklama", self.caption_var)
        self._field(settings, 6, "Cloudinary Cloud Name", self.cloud_name_var)
        self._field(settings, 7, "Cloudinary Upload Preset", self.upload_preset_var)
        ttk.Label(settings, text="Cloudinary alanları unsigned preset ile doldurulmalı.", foreground="#667085").grid(row=8, column=0, columnspan=3, sticky="w", pady=(8, 0))
        ttk.Button(settings, text="Ayarları kaydet", command=self._save_settings_ui).grid(row=9, column=0, columnspan=3, sticky="ew", pady=(10, 0))

        source_box = ttk.LabelFrame(content, text="Reel kaynakları", style="Card.TLabelframe", padding=14)
        source_box.grid(row=0, column=1, sticky="nsew", padx=(10, 0), pady=(0, 12))
        source_box.rowconfigure(1, weight=1)
        source_box.columnconfigure(0, weight=1)
        source_tools = ttk.Frame(source_box)
        source_tools.grid(row=0, column=0, sticky="ew", pady=(0, 7))
        self.source_count = ttk.Label(source_tools, text="0 bağlantı hazır", foreground="#667085")
        self.source_count.pack(side="left")
        ttk.Button(source_tools, text="Yapıştır", command=self._paste_sources).pack(side="right")
        ttk.Button(source_tools, text="Temizle", command=self._clear_sources).pack(side="right", padx=(0, 6))
        self.sources_text = scrolledtext.ScrolledText(source_box, height=9, wrap="word", font=("TkDefaultFont", 10), relief="solid", borderwidth=1, background="#fbfcfe", foreground="#344054", insertbackground="#344054", padx=10, pady=9)
        self.sources_text.grid(row=1, column=0, sticky="nsew")
        self.sources_text.insert("1.0", "# Örnekleri silip kendi reel linklerini yaz\n")
        self.sources_text.bind("<<Modified>>", self._source_text_changed)
        source_actions = ttk.Frame(source_box)
        source_actions.grid(row=2, column=0, sticky="ew", pady=(8, 0))
        ttk.Button(source_actions, text="sources.txt yükle", command=self._load_sources_file).pack(side="left")
        ttk.Button(source_actions, text="İçe aktar", command=self._import_sources).pack(side="left", padx=5)
        ttk.Button(source_actions, text="Dışa aktar", command=self._export_sources).pack(side="left")
        source_manage = ttk.Frame(source_box)
        source_manage.grid(row=3, column=0, sticky="ew", pady=(5, 0))
        ttk.Button(source_manage, text="Tekilleştir", command=self._dedupe_sources).pack(side="right")
        ttk.Button(source_manage, text="Bağlantıları denetle", command=self._validate_sources).pack(side="right", padx=5)

        self.stats = {}
        statbar = ttk.Frame(root)
        statbar.pack(fill="x", pady=(0, 12), before=content)
        for i, (key, title) in enumerate((("pending", "BEKLEYEN"), ("downloaded", "İNDİRİLEN"), ("published", "YAYINLANAN"), ("failed", "HATALI"))):
            card = ttk.LabelFrame(statbar, text=title, style="Card.TLabelframe", padding=(10, 4))
            card.pack(side="left", fill="x", expand=True, padx=(0 if i == 0 else 6, 0))
            self.stats[key] = ttk.Label(card, text="–", font=("TkDefaultFont", 17, "bold"))
            self.stats[key].pack(anchor="w")

        queue_box = ttk.LabelFrame(content, text="Kuyruk ve işlemler", style="Card.TLabelframe", padding=14)
        queue_box.grid(row=1, column=0, columnspan=2, sticky="nsew")
        queue_box.columnconfigure(0, weight=1)
        queue_box.rowconfigure(2, weight=1)
        actions = ttk.Frame(queue_box)
        actions.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        self.run_button = ttk.Button(actions, text="▶  Yayınlamayı başlat", style="Accent.TButton", command=self._start_run)
        self.run_button.pack(side="left")
        self.download_button = ttk.Button(actions, text="⬇  Tokensiz indir", command=self._start_download_only)
        self.download_button.pack(side="left", padx=(8, 0))
        self.dry_button = ttk.Button(actions, text="Deneme (dry-run)", command=self._dry_run)
        self.dry_button.pack(side="left", padx=(8, 0))
        ttk.Button(actions, text="Kuyruğu yenile", command=self._show_status).pack(side="left", padx=(8, 0))
        ttk.Button(actions, text="Başarısızları yeniden dene", command=self._retry_failed).pack(side="left", padx=(8, 0))
        log_actions = ttk.Frame(queue_box)
        log_actions.grid(row=1, column=0, sticky="ew", pady=(0, 6))
        ttk.Label(log_actions, text="CANLI İŞLEM AKIŞI", foreground="#667085").pack(side="left")
        self.log_filter_var = tk.StringVar()
        self.log_filter_var.trace_add("write", lambda *_: self._render_logs())
        ttk.Entry(log_actions, textvariable=self.log_filter_var, width=22).pack(side="left", padx=(12, 5))
        ttk.Label(log_actions, text="kayıtlarda ara", foreground="#667085").pack(side="left")
        ttk.Button(log_actions, text="Kopyala", command=self._copy_logs).pack(side="right", padx=(0, 6))
        ttk.Button(log_actions, text="Logları dışa aktar", command=self._export_logs).pack(side="right")
        ttk.Button(log_actions, text="Temizle", command=self._clear_logs).pack(side="right", padx=(0, 6))
        self.log = scrolledtext.ScrolledText(queue_box, height=12, wrap="word", state="disabled", font=("TkFixedFont", 9), background="#111827", foreground="#d0d5dd", insertbackground="white", relief="flat", padx=12, pady=10)
        self.log.grid(row=2, column=0, sticky="nsew")

        ttk.Label(root, text="Güvenli kullanım: yalnızca haklarına sahip olduğun veya yayın izni aldığın videoları kullan.", background="#f3f5fa", foreground="#b54708").pack(anchor="w", pady=(12, 0))
        self._animate_status()
        self._apply_theme()
        self.bind_all("<Control-Return>", lambda _e: self._start_run())
        self.bind_all("<Control-l>", lambda _e: self._clear_logs())
        self.bind_all("<Control-Shift-v>", lambda _e: self._paste_sources())

    def _load_theme_preference(self) -> str:
        try:
            value = json.loads(Path("ui_preferences.json").read_text(encoding="utf-8")).get("theme", "Otomatik")
            return value if value in {"Açık", "Koyu", "Otomatik"} else "Otomatik"
        except (OSError, ValueError, AttributeError):
            return "Otomatik"

    def _change_theme(self, _event=None) -> None:
        Path("ui_preferences.json").write_text(json.dumps({"theme": self.theme_var.get()}, ensure_ascii=False, indent=2), encoding="utf-8")
        self._apply_theme()

    def _apply_theme(self) -> None:
        dark = self.theme_var.get() == "Koyu"
        if self.theme_var.get() == "Otomatik":
            dark = self._system_prefers_dark()
        c = ({"bg": "#111827", "panel": "#1f2937", "fg": "#f3f4f6", "muted": "#aab4c5", "input": "#111827", "border": "#374151", "accent": "#8b7cff", "log": "#090e18", "logfg": "#e5e7eb"} if dark else {"bg": "#f3f5fa", "panel": "#ffffff", "fg": "#101828", "muted": "#667085", "input": "#fbfcfe", "border": "#d9deea", "accent": "#6c5ce7", "log": "#111827", "logfg": "#d0d5dd"})
        self.configure(bg=c["bg"])
        style = ttk.Style(self)
        style.configure("TFrame", background=c["bg"])
        style.configure("TLabel", background=c["panel"], foreground=c["fg"])
        style.configure("Title.TLabel", background=c["bg"], foreground=c["fg"])
        style.configure("Subtitle.TLabel", background=c["bg"], foreground=c["muted"])
        style.configure("Status.TLabel", background=c["bg"], foreground=c["fg"])
        style.configure("Card.TLabelframe", background=c["panel"], bordercolor=c["border"])
        style.configure("Card.TLabelframe.Label", background=c["panel"], foreground=c["fg"])
        style.configure("TEntry", fieldbackground=c["input"], foreground=c["fg"])
        style.configure("TCombobox", fieldbackground=c["input"], foreground=c["fg"])
        style.configure("TButton", background=c["panel"], foreground=c["fg"])
        style.configure("TCheckbutton", background=c["panel"], foreground=c["fg"])
        style.configure("Accent.TButton", background=c["accent"], foreground="#ffffff")
        style.configure("Horizontal.TProgressbar", troughcolor=c["border"], background=c["accent"])
        self.activity_dot.configure(bg=c["bg"])
        self.progress_ring.configure(bg=c["bg"])
        self.progress_ring.itemconfigure(self.progress_arc, outline=c["accent"])
        self.progress_ring.itemconfigure(self.progress_track, outline=c["border"])
        self.progress_ring.itemconfigure(self.progress_text, fill=c["fg"])
        self.sources_text.configure(bg=c["input"], fg=c["fg"], insertbackground=c["fg"], selectbackground=c["accent"])
        self.log.configure(bg=c["log"], fg=c["logfg"], insertbackground=c["logfg"])

    @staticmethod
    def _system_prefers_dark() -> bool:
        system = platform.system()
        try:
            if system == "Windows":
                import winreg
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
                return winreg.QueryValueEx(key, "AppsUseLightTheme")[0] == 0
            if system == "Darwin":
                return subprocess.check_output(["defaults", "read", "-g", "AppleInterfaceStyle"], stderr=subprocess.DEVNULL, text=True).strip().lower() == "dark"
            return "dark" in os.environ.get("GTK_THEME", "").lower()
        except (OSError, subprocess.SubprocessError, ImportError):
            return False

    def _animate_status(self) -> None:
        active = bool(self._worker and self._worker.is_alive())
        if active:
            self._pulse_on = not getattr(self, "_pulse_on", False)
            self.activity_dot.itemconfigure(self.dot, fill="#6c5ce7" if self._pulse_on else "#c4bfff")
            radius = 6 if self._pulse_on else 4
            self.activity_dot.coords(self.dot, 9-radius, 9-radius, 9+radius, 9+radius)
            if not self.progress.winfo_ismapped():
                self.progress.pack(fill="x", pady=(0, 14))
            if not self._progress_running:
                self.progress.start(12)
                self._progress_running = True
        else:
            self.activity_dot.itemconfigure(self.dot, fill="#12b76a")
            self.activity_dot.coords(self.dot, 4, 4, 14, 14)
            if self._progress_running:
                self.progress.stop()
                self._progress_running = False
            self.progress.pack_forget()
        self.after(450, self._animate_status)

    def _source_text_changed(self, _event=None) -> None:
        self.sources_text.edit_modified(False)
        lines = [line.strip() for line in self.sources_text.get("1.0", "end").splitlines() if line.strip() and not line.strip().startswith("#")]
        unique, duplicates = deduplicate_source_lines(lines)
        suffix = f" · {duplicates} tekrar" if duplicates else ""
        self.source_count.configure(text=f"{len(lines)} bağlantı hazır{suffix}")

    def _set_progress(self, percent: int, current: int = 0, total: int = 0, stage: str = "") -> None:
        self._target_progress = max(0, min(100, int(percent)))
        self._progress_meta = (current, total, stage)
        if stage:
            count = f"{current}/{total} · " if total else ""
            self.status_label.configure(text=f"{self._target_progress}% · {count}{stage}")
        if not self._progress_animation_pending:
            self._animate_percentage()

    def _animate_percentage(self) -> None:
        difference = self._target_progress - self._display_progress
        if abs(difference) > 0.4:
            self._display_progress += max(-3.5, min(3.5, difference * 0.22))
            value = int(round(self._display_progress))
            self.progress_ring.itemconfigure(self.progress_arc, extent=-3.6 * self._display_progress)
            self.progress_ring.itemconfigure(self.progress_text, text=f"{value}%")
            self._progress_animation_pending = True
            self.after(16, self._animate_percentage)
        else:
            self._progress_animation_pending = False
            self._display_progress = float(self._target_progress)
            self.progress_ring.itemconfigure(self.progress_arc, extent=-3.6 * self._target_progress)
            self.progress_ring.itemconfigure(self.progress_text, text=f"{self._target_progress}%")

    def _paste_sources(self) -> None:
        try:
            text = self.clipboard_get()
            current = self.sources_text.get("1.0", "end").strip()
            self.sources_text.insert("end", ("\n" if current else "") + text)
            self._source_text_changed()
        except tk.TclError:
            self._log("Panoda yapıştırılacak metin bulunamadı.")

    def _clear_sources(self) -> None:
        self.sources_text.delete("1.0", "end")
        self._source_text_changed()

    def _clear_logs(self) -> None:
        self._log_history.clear()
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    def _copy_logs(self) -> None:
        text = "\n".join(self._visible_log_lines())
        if text:
            self.clipboard_clear()
            self.clipboard_append(text)
            self.status_label.configure(text="Görünen loglar kopyalandı")

    def _visible_log_lines(self) -> list[str]:
        term = self.log_filter_var.get().strip().lower()
        return [line for line in self._log_history if not term or term in line.lower()]

    def _render_logs(self) -> None:
        if not hasattr(self, "log"):
            return
        lines = self._visible_log_lines() if hasattr(self, "log_filter_var") else self._log_history
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        if lines:
            self.log.insert("end", "\n".join(lines) + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _export_logs(self) -> None:
        path = filedialog.asksaveasfilename(title="İşlem kayıtlarını kaydet", defaultextension=".txt", initialfile=f"reels-transfer-{datetime.now():%Y%m%d-%H%M}.txt", filetypes=[("Metin dosyası", "*.txt")])
        if path:
            Path(path).write_text("\n".join(self._log_history) + "\n", encoding="utf-8")
            self._log(f"İşlem kayıtları kaydedildi: {path}")

    def _field(self, parent: ttk.LabelFrame, row: int, label: str, variable: tk.StringVar, show: str | None = None):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=4, padx=(0, 10))
        entry = ttk.Entry(parent, textvariable=variable, show=show or "")
        entry.grid(row=row, column=1, sticky="ew", pady=4)
        return entry

    def _toggle_token(self) -> None:
        self.token_entry.configure(show="" if self.reveal_token.get() else "*")

    def _save_settings_ui(self) -> None:
        try:
            self._save_settings()
            self._log("Ayarlar .env dosyasına kaydedildi.")
            self.status_label.configure(text="Ayarlar kaydedildi")
        except (OSError, ValueError) as exc:
            messagebox.showerror("Ayar kaydedilemedi", str(exc))

    def _import_sources(self) -> None:
        path = filedialog.askopenfilename(title="Kaynak listesini içe aktar", filetypes=[("Metin/CSV", "*.txt *.csv"), ("Tüm dosyalar", "*.*")])
        if path:
            incoming = Path(path).read_text(encoding="utf-8-sig")
            current = self.sources_text.get("1.0", "end-1c").strip()
            self.sources_text.insert("end", ("\n" if current else "") + incoming)
            self._source_text_changed()
            self._log(f"Kaynak listesi içe aktarıldı: {Path(path).name}")

    def _export_sources(self) -> None:
        path = filedialog.asksaveasfilename(title="Kaynak listesini dışa aktar", defaultextension=".txt", filetypes=[("Metin dosyası", "*.txt"), ("CSV dosyası", "*.csv")])
        if path:
            Path(path).write_text(self.sources_text.get("1.0", "end-1c").strip() + "\n", encoding="utf-8")
            self._log(f"Kaynak listesi dışa aktarıldı: {Path(path).name}")

    def _dedupe_sources(self) -> None:
        result, removed = deduplicate_source_lines(self.sources_text.get("1.0", "end").splitlines())
        self.sources_text.delete("1.0", "end")
        self.sources_text.insert("1.0", "\n".join(result) + "\n")
        self._source_text_changed()
        self._log(f"Tekilleştirme bitti: {removed} yinelenen satır kaldırıldı.")

    def _validate_sources(self) -> None:
        lines = [line.strip() for line in self.sources_text.get("1.0", "end").splitlines() if line.strip() and not line.strip().startswith("#")]
        invalid = []
        for i, line in enumerate(lines, 1):
            url = line.partition("|")[0].strip()
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"} or parsed.netloc.lower() not in {"instagram.com", "www.instagram.com"}:
                invalid.append((i, url))
        self.source_count.configure(text=f"{len(lines)-len(invalid)}/{len(lines)} geçerli bağlantı")
        if invalid:
            for i, url in invalid[:10]:
                self._log(f"Bağlantı denetimi: {i}. satır şüpheli — {url}")
            messagebox.showwarning("Bağlantılar denetlendi", f"{len(lines)} satırdan {len(invalid)} tanesi Instagram URL biçiminde görünmüyor. Satırlar listede korundu.")
        else:
            messagebox.showinfo("Bağlantılar denetlendi", f"{len(lines)} Instagram bağlantısı biçimsel olarak uygun görünüyor.")

    def _load_existing_env(self) -> None:
        env = Path(".env")
        if not env.exists():
            return
        try:
            from dotenv import dotenv_values
            values = dotenv_values(env)
            self.token_var.set(values.get("IG_ACCESS_TOKEN", "") or "")
            self.user_id_var.set(values.get("IG_USER_ID", "") or "")
            self.max_posts_var.set(values.get("MAX_POSTS_PER_RUN", "3") or "3")
            self.poll_seconds_var.set(values.get("STATUS_POLL_SECONDS", "60") or "60")
            self.poll_attempts_var.set(values.get("STATUS_POLL_ATTEMPTS", "5") or "5")
            self.caption_var.set(values.get("DEFAULT_CAPTION", "") or "")
            self.cloud_name_var.set(values.get("CLOUDINARY_CLOUD_NAME", "") or "")
            self.upload_preset_var.set(values.get("CLOUDINARY_UPLOAD_PRESET", "") or "")
        except Exception as exc:
            self._log(f".env okunamadı: {type(exc).__name__}")

    def _load_sources_file(self) -> None:
        path = Path("sources.txt")
        if not path.exists():
            messagebox.showwarning("Dosya yok", "sources.txt bulunamadı.")
            return
        self.sources_text.delete("1.0", "end")
        self.sources_text.insert("1.0", path.read_text(encoding="utf-8"))
        self._source_text_changed()
        self._log("sources.txt arayüze yüklendi.")

    def _save_settings(self) -> None:
        path = Path(".env")
        if not path.exists():
            example = Path(".env.example")
            path.write_text(example.read_text(encoding="utf-8") if example.exists() else "", encoding="utf-8")
        values = {
            "IG_ACCESS_TOKEN": self.token_var.get().strip(),
            "IG_USER_ID": self.user_id_var.get().strip(),
            "MAX_POSTS_PER_RUN": self.max_posts_var.get().strip(),
            "STATUS_POLL_SECONDS": self.poll_seconds_var.get().strip(),
            "STATUS_POLL_ATTEMPTS": self.poll_attempts_var.get().strip(),
            "DEFAULT_CAPTION": self.caption_var.get(),
            "IG_API_MODE": "instagram_login",
            "PUBLIC_UPLOAD_MODE": "cloudinary",
            "CLOUDINARY_CLOUD_NAME": self.cloud_name_var.get().strip(),
            "CLOUDINARY_UPLOAD_PRESET": self.upload_preset_var.get().strip(),
            "CONTENT_RIGHTS_CONFIRMED": "true",
        }
        for key, value in values.items():
            set_key(str(path), key, value, quote_mode="auto")

    def _save_sources(self) -> None:
        result, removed = deduplicate_source_lines(self.sources_text.get("1.0", "end").splitlines())
        if removed:
            self.sources_text.delete("1.0", "end")
            self.sources_text.insert("1.0", "\n".join(result) + "\n")
            self._source_text_changed()
            self._log(f"Aynı Reel ({removed} tekrar) listeden çıkarıldı; ilk kayıt korundu.")
        Path("sources.txt").write_text("\n".join(result).strip() + "\n", encoding="utf-8")

    @staticmethod
    def _valid_unique_source_count(path: Path) -> int:
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.strip().startswith("#")]
        unique, _ = deduplicate_source_lines(lines)
        count = 0
        for line in unique:
            try:
                extract_shortcode(line.partition("|")[0].strip())
                count += 1
            except ValueError:
                continue
        return count

    def _settings(self) -> Settings:
        self._save_settings()
        return load_settings()

    def _prepare_store(self) -> tuple[Settings, StateStore]:
        settings = self._settings()
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        return settings, StateStore(settings.db_path)

    def _dry_run(self) -> None:
        try:
            self._save_sources()
            settings, store = self._prepare_store()
            try:
                added = load_sources(Path("sources.txt"), store, settings.default_caption)
                candidates = self._valid_unique_source_count(Path("sources.txt"))
                jobs = store.pending_jobs(settings.max_posts_per_run)
                self._log(f"Deneme tamamlandı: {added} yeni iş; {max(0, candidates-added)} tekrar/önceden eklenmiş URL atlandı; {len(jobs)} bekleyen iş.")
                for job in jobs:
                    self._log(f"• {job.source_url} | {job.caption}")
                self._show_summary(store.summary())
            finally:
                store.close()
        except (ConfigError, ValueError, OSError) as exc:
            messagebox.showerror("Ayar hatası", str(exc))
            self._log(f"HATA: {exc}")

    def _start_run(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        try:
            self._save_sources()
            settings = self._settings()
        except (ConfigError, ValueError, OSError) as exc:
            messagebox.showerror("Ayar hatası", str(exc))
            return
        self._stop_event.clear()
        self.run_button.configure(state="disabled")
        self.download_button.configure(state="disabled")
        self.dry_button.configure(state="disabled")
        self._set_progress(0, 0, 0, "Sıra hazırlanıyor")
        self._worker = threading.Thread(target=self._run_worker, args=(settings,), daemon=True)
        self._worker.start()

    def _download_config(self) -> tuple[Path, Path | None]:
        """Token istemeden yalnızca indirme için DATA_DIR ve opsiyonel çerezi okur."""
        values = dotenv_values(".env") if Path(".env").exists() else {}
        data_dir = Path((values.get("DATA_DIR") or "./data").strip() or "./data")
        cookie_text = (values.get("COOKIES_FILE") or "").strip()
        cookies = Path(cookie_text) if cookie_text else None
        if cookies is not None and not cookies.exists():
            raise ConfigError(f"COOKIES_FILE bulunamadı: {cookies}")
        return data_dir, cookies

    def _start_download_only(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        try:
            self._save_sources()
            data_dir, cookies = self._download_config()
            lines = Path("sources.txt").read_text(encoding="utf-8").splitlines()
            jobs = []
            for raw_line in lines:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                url, _, _caption = (part.strip() for part in line.partition("|"))
                try:
                    shortcode = extract_shortcode(url)
                except ValueError:
                    # Profil/başka public Instagram URL'leri için de yt-dlp'ye şans ver.
                    # Dosya adını URL'den türet; aynı profil URL'si tekrar yazılırsa üzerine yazar.
                    parsed = urlparse(url)
                    if parsed.netloc.lower() not in {"instagram.com", "www.instagram.com"}:
                        raise
                    slug = parsed.path.strip("/").split("/")[-1] or "instagram"
                    safe_slug = "".join(char if char.isalnum() or char in "-_" else "_" for char in slug)
                    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]
                    shortcode = f"{safe_slug[:50]}-{digest}"
                jobs.append((url, shortcode, data_dir, cookies))
            if not jobs:
                messagebox.showwarning("Link yok", "Önce sağdaki alana en az bir Instagram reel linki yaz.")
                return
        except (ConfigError, ValueError, OSError) as exc:
            messagebox.showerror("İndirme ayarı hatası", str(exc))
            return

        self.run_button.configure(state="disabled")
        self.download_button.configure(state="disabled")
        self.dry_button.configure(state="disabled")
        self._set_progress(0, 0, len(jobs), "Tokensiz indirme")
        self._worker = threading.Thread(target=self._download_worker, args=(jobs,), daemon=True)
        self._worker.start()

    def _download_worker(self, jobs: list[tuple[str, str, Path, Path | None]]) -> None:
        downloaded = failed = skipped = 0
        total = len(jobs)
        self._events.put(("progress", {"percent": 0, "current": 0, "total": total, "stage": "İndirme başlıyor"}))
        for index, (url, shortcode, data_dir, cookies) in enumerate(jobs):
            try:
                download_dir = data_dir / "downloads"
                previous = next((p for p in download_dir.glob(f"{shortcode}.*") if p.is_file() and p.stat().st_size > 0 and p.suffix not in {".part", ".ytdl"}), None) if download_dir.exists() else None
                if previous:
                    target = previous
                    skipped += 1
                    self._events.put(("log", f"Daha önce indirilmiş, tekrar atlandı: {target.name}"))
                else:
                    target = download_reel(url, shortcode, download_dir, cookies)
                if not previous:
                    downloaded += 1
                    self._events.put(("log", f"İndirildi: {target}"))
            except (DownloadError, OSError, ValueError) as exc:
                failed += 1
                self._events.put(("log", f"İndirilemedi ({shortcode}): {exc}"))
            self._events.put(("progress", {"percent": int((index + 1) * 100 / total), "current": index + 1, "total": total, "stage": f"İndirme {index+1}/{total}"}))
        self._events.put(("download_done", {"downloaded": downloaded, "failed": failed, "skipped": skipped}))

    def _run_worker(self, settings: Settings) -> None:
        store = StateStore(settings.db_path)
        try:
            added = load_sources(Path("sources.txt"), store, settings.default_caption)
            candidates = self._valid_unique_source_count(Path("sources.txt"))
            self._events.put(("log", f"{added} yeni reel kuyruğa eklendi; {max(0, candidates-added)} aynı veya daha önce eklenmiş URL atlandı."))
            publisher = InstagramPublisher(
                settings.access_token,
                settings.ig_user_id,
                settings.graph_version,
                settings.status_poll_seconds,
                settings.status_poll_attempts,
                api_mode=settings.api_mode,
                public_upload_mode=settings.public_upload_mode,
                cloudinary_cloud_name=settings.cloudinary_cloud_name,
                cloudinary_upload_preset=settings.cloudinary_upload_preset,
            )
            result = run_once(settings, store, publisher, progress_callback=lambda percent, current, total, stage, code: self._events.put(("progress", {"percent": percent, "current": current, "total": total, "stage": f"{stage} · {code}" if code else stage})))
            for shortcode, source_url, error in store.failure_details():
                self._events.put(("log", f"HATA ({shortcode}): {error or 'detay yok'}"))
            self._events.put(("done", result))
        except (InstagramApiError, MediaError, ConfigError, OSError, ValueError) as exc:
            self._events.put(("error", str(exc)))
        finally:
            summary = store.summary()
            store.close()
            self._events.put(("summary", summary))

    def _show_status(self) -> None:
        try:
            settings, store = self._prepare_store()
            try:
                self._show_summary(store.summary())
            finally:
                store.close()
        except (ConfigError, ValueError, OSError) as exc:
            messagebox.showerror("Ayar hatası", str(exc))

    def _retry_failed(self) -> None:
        try:
            settings, store = self._prepare_store()
            try:
                count = store.reset_failed()
                self._log(f"{count} başarısız iş tekrar kuyruğa alındı.")
                self._show_summary(store.summary())
            finally:
                store.close()
        except (ConfigError, ValueError, OSError) as exc:
            messagebox.showerror("Ayar hatası", str(exc))

    def _show_summary(self, summary: dict[str, int]) -> None:
        for key, label in self.stats.items():
            label.configure(text=str(summary.get(key, 0)))
        self.status_label.configure(text=f"Toplam {sum(summary.values())} iş")

    def _log(self, text: str) -> None:
        self._log_history.append(f"{datetime.now():%H:%M:%S}  {text}")
        self._render_logs()

    def _process_events(self) -> None:
        try:
            while True:
                kind, data = self._events.get_nowait()
                if kind == "log":
                    self._log(str(data))
                elif kind == "progress":
                    event = data if isinstance(data, dict) else {}
                    self._set_progress(int(event.get("percent", 0)), int(event.get("current", 0)), int(event.get("total", 0)), str(event.get("stage", "")))
                elif kind == "done":
                    self._log(f"Tur tamamlandı: {data}")
                    if self._target_progress == 0:
                        self._set_progress(100, 0, 0, "Kuyruk boş")
                    self.run_button.configure(state="normal")
                    self.download_button.configure(state="normal")
                    self.dry_button.configure(state="normal")
                    self.status_label.configure(text="Tamamlandı")
                elif kind == "download_done":
                    self._log(f"Tokensiz indirme tamamlandı: {data}")
                    self.run_button.configure(state="normal")
                    self.download_button.configure(state="normal")
                    self.dry_button.configure(state="normal")
                    self.status_label.configure(text="İndirme tamamlandı")
                elif kind == "error":
                    self._log(f"HATA: {data}")
                    messagebox.showerror("Çalıştırma hatası", str(data))
                    self.run_button.configure(state="normal")
                    self.download_button.configure(state="normal")
                    self.dry_button.configure(state="normal")
                    self.status_label.configure(text="Hata oluştu")
                elif kind == "summary":
                    self._show_summary(data if isinstance(data, dict) else {})
        except queue.Empty:
            pass
        self.after(150, self._process_events)


def main() -> int:
    app = ReelsApp()
    app.mainloop()
    return 0
