# reels-transfer

Instagram'daki reel bağlantılarını (yalnızca **hakkına sahip olduğun** veya **izin aldığın** içerikleri)
indirip kendi Instagram İşletme hesabında Reel olarak yeniden yayınlayan küçük bir araç.

## Dosya yapısı

```
reels-transfer/
├── reels_transfer/
│   ├── __init__.py        # sürüm bilgisi
│   ├── __main__.py        # python -m reels_transfer giriş noktası
│   ├── gui.py             # Tkinter masaüstü arayüzü
│   ├── cli.py             # komut satırı (run / status / retry-failed)
│   ├── config.py          # .env → Settings
│   ├── state.py           # SQLite kuyruk (tekrar paylaşımı engeller)
│   ├── sources.py         # sources.txt okuma + shortcode çıkarma
│   ├── downloader.py      # yt-dlp ile indirme
│   ├── media.py           # ffmpeg ile Reels'e uygun hale getirme
│   ├── publisher.py       # Instagram Graph API (resumable upload)
│   └── pipeline.py        # indir → hazırla → yayınla akışı
├── tests/                 # pytest testleri
├── requirements.txt
├── .env.example
├── sources.txt            # işlenecek reel listesi
└── calistir.sh            # kurulum + çalıştırma betiği
```

## Masaüstü arayüzünü açma

Terminalde proje klasöründe:

```bash
source .venv/bin/activate
python -m reels_transfer gui
```

Arayüzden token, Instagram kullanıcı ID'si ve diğer ayarları girebilir; reel linklerini
satır satır ekleyebilir; **Deneme**, **Tokensiz indir**, **Yayınlamayı başlat**, **Kuyruğu yenile** ve
**Başarısızları yeniden dene** düğmelerini kullanabilirsin. Ayarlar `.env`, kaynaklar
`sources.txt` dosyasına kaydedilir. Pencere donmasın diye yayın işlemi arka planda çalışır.

Yeni arayüz özellikleri: **Açık / Koyu / Otomatik tema** (tercih `ui_preferences.json` içine kaydedilir),
tokenı geçici göster/gizle, ayarları elle kaydet, kuyruk durum kartları, kaynak listesini metin/CSV
olarak içe-dışa aktar, yinelenen bağlantıları tekilleştir ve Instagram URL biçimini önceden denetle.
Canlı kayıtlar saat damgalıdır; kayıt arama, panoya kopyalama ve dışa aktarma desteklenir.
Klavye kısayolları: `Ctrl+Enter` yayın turu, `Ctrl+L` kayıtları temizle, `Ctrl+Shift+V` panodan
kaynak ekle.

Yayın/indirme sırasında başlıktaki **yüzde halkası** gerçek işlem adımlarına göre 0–100 arasında
animasyonla ilerler; mevcut kayan yatay çalışma animasyonu da çalışmaya devam eder. Aynı Reel'in
farklı `reel`/`reels` bağlantıları veya takip parametreli URL'leri shortcode üzerinden tek kabul
edilir. Liste kaydedilirken aynı Reel'in tekrarları ilk satır korunarak temizlenir; veritabanında
daha önce bulunan (özellikle yayınlanmış) Reel yeni bir işe eklenmez. Tokensiz indirmede dosyası
zaten mevcut olan URL atlanır.

**Tokensiz indir** yalnızca yt-dlp ile public Instagram içeriğini `data/downloads` klasörüne
indirir; Instagram Graph API tokenı istemez ve hiçbir şey yayınlamaz. Reel URL'si yanında public
profil URL'si de denenebilir. Instagram giriş istiyorsa `.env` içine `COOKIES_FILE` ile Netscape
formatında çerez dosyası vermen gerekebilir.

Linux/macOS'ta kolay açmak için:

```bash
bash arayuz.sh
```

Windows'ta `arayuz.bat` dosyasına çift tıklayabilirsin.

## Web paneli: telefon, tablet ve bilgisayar

`mobile-site/` klasöründe Supabase kuyruğuna bağlanan, yüklenebilir PWA paneli bulunur. Aynı arayüz Android/iOS tarayıcılarında, tabletlerde ve masaüstü tarayıcılarda duyarlı çalışır; ana ekrana eklenebilir. Reel linklerini yapıştırabilir, shortcode tekrarlarını otomatik atlatabilir ve yayın durumunu yüzde/aşama olarak izleyebilirsin. **Web panelinde Reel başına gün/saat ayarı yoktur**; sıradaki içerikleri bulut işçisi işler.

Panelin kurulumu için [`mobile-site/README.md`](mobile-site/README.md) dosyasına bak. Canlı adres: [https://hymenrus.github.io/reels-transfer/](https://hymenrus.github.io/reels-transfer/). Gerçek Instagram yayıncılığı için GitHub Actions secrets/variables ve Supabase Auth yönlendirme adresi yapılandırılmalıdır.

## Kurulum

Gereksinim: Python 3.10+, ffmpeg ve masaüstü arayüzü için Tkinter.

```bash
# ffmpeg
# macOS:    brew install ffmpeg
# Ubuntu:   sudo apt install ffmpeg
# Windows:  winget install ffmpeg
# Ubuntu GUI: sudo apt install python3-tk

python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # sonra .env içini doldur
```

### .env alanları

| Değişken | Açıklama |
| --- | --- |
| `IG_ACCESS_TOKEN` | Instagram Graph API uzun ömürlü erişim token'ı |
| `IG_USER_ID` | Reel'lerin yayınlanacağı Instagram profesyonel hesap ID'si |
| `GRAPH_API_VERSION` | Varsayılan `v26.0` |
| `IG_API_MODE` | Instagram Login için `instagram_login`; eski Facebook Page akışı için `facebook_login` |
| `PUBLIC_UPLOAD_MODE` | Instagram Login yerel videoları için `cloudinary` (önerilen) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary Dashboard'daki Cloud Name |
| `CLOUDINARY_UPLOAD_PRESET` | Settings → Upload → Upload Presets içindeki **Unsigned** preset adı |
| `DATA_DIR` | Kuyruk dosyası ve indirmelerin klasörü (varsayılan `./data`) |
| `MAX_POSTS_PER_RUN` | Bir turda en fazla kaç reel yayınlanacak |
| `DEFAULT_CAPTION` | Açıklama verilmezse kullanılacak metin (`{source_url}` değiştirilir) |
| `COOKIES_FILE` | Giriş gerektiren reel'ler için Netscape biçiminde çerez dosyası |
| `STATUS_POLL_SECONDS` / `STATUS_POLL_ATTEMPTS` | Video işlenme durumu kontrol aralığı ve deneme sayısı |
| `CONTENT_RIGHTS_CONFIRMED` | `true` olmadan araç çalışmaz (telif onayı) |

## Kaynak listesi (`sources.txt`)

Her satır bir reel; açıklama vermek istersen `|` ile ayır:

```
https://www.instagram.com/reel/XXXXXXXXXXX/ | Kendi açıklamam #etiket
https://www.instagram.com/reel/YYYYYYYYYYY/
```

`#` ile başlayan satırlar ve boş satırlar atlanır. Aynı reel (shortcode) ikinci kez eklenmez.

## Çalıştırma

```bash
# 1) Önce deneme: hiçbir şey indirmez/yayınlamaz, sadece kuyruğu gösterir
python -m reels_transfer run --dry-run

# 2) Tek sefer çalıştır (MAX_POSTS_PER_RUN kadar paylaşır)
python -m reels_transfer run

# 3) Her 3 saatte bir kendiliğinden çalışsın
python -m reels_transfer run --loop-minutes 180

# Kuyruk durumu / başarısızları tekrar dene
python -m reels_transfer status
python -m reels_transfer retry-failed
```

Tek seferde hepsini kurup çalıştırmak için:

```bash
bash calistir.sh
```

## Zamanlanmış çalıştırma (cron)

```cron
0 */3 * * * cd /yol/reels-transfer && .venv/bin/python -m reels_transfer run >> data/run.log 2>&1
```

## Testler

```bash
.venv/bin/python -m pytest -q
```

## Nasıl çalışır

1. `sources.txt` okunur, her reel `shortcode` ile SQLite kuyruğa `pending` olarak eklenir.
2. Kota (`content_publishing_limit`) ve `MAX_POSTS_PER_RUN` sınırına göre tur bütçesi belirlenir.
3. Her iş için: yt-dlp ile indirme → ffmpeg ile 1080×1920 H.264/AAC mp4 üretimi →
   `POST /media` (resumable container) → `rupload.facebook.com` üzerine yükleme →
   `status_code == FINISHED` olana dek bekleme → `media_publish`.
4. Yayınlanan işler `published`, hata alanlar `failed` olarak işaretlenir; geçici dosyalar silinir.

Instagram Login modunda Windows'taki yerel video Meta tarafından görülemediği için uygulama,
`PUBLIC_UPLOAD_MODE=cloudinary` ayarıyla videoyu Cloudinary CDN'ine doğrudan MP4 HTTPS URL'si olarak yükler; ardından Meta bu
URL'den videoyu alıp yayınlar. Bu hizmeti kullanmak istemezsen `PUBLIC_UPLOAD_MODE=none` yapıp
kendi HTTPS medya barındırma/uploader çözümünü eklemelisin.

### Cloudinary kurulumu

1. [Cloudinary kayıt sayfasını](https://cloudinary.com/users/register_free) açıp ücretsiz hesap oluştur.
2. Dashboard'dan **Cloud Name** değerini kopyala.
3. **Settings → Upload → Upload Presets → Add upload preset** seç.
4. Presetin **Signing Mode** değerini `Unsigned` yap; video formatına izin ver ve kaydet.
5. Cloud Name ve preset adını arayüzdeki Cloudinary alanlarına yaz veya `.env` içine koy.

Unsigned preset herkese açık yükleme noktası olduğundan dosya boyutu/format/folder kısıtlarını preset ayarlarından daralt.

## Notlar ve sınırlar

- 24 saat içinde paylaşılabilecek Reel sayısı API kotasıyla sınırlıdır (`quota_total`).
- Yalnızca kendi oluşturduğun veya yayın izni aldığın içerikleri kullan; başkasının içeriğini
  izinsiz yeniden yayınlamak Instagram kurallarını ve telif hakkını ihlal eder.
- Token hiçbir zaman log'a veya hata mesajına yazılmaz; yükleme isteği yalnızca
  `rupload.facebook.com` adresine gönderilir.
