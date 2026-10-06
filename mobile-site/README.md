# ReelFlow — mobil Reels kuyruğu

Reels Transfer masaüstü projesine eklenen; telefon, tablet ve masaüstü tarayıcılarında çalışan, ana ekrana kurulabilen PWA arayüzü. **Kullanıcıya Reel başına saat/gün planı sunmaz:** eklenen videolar sıraya girer ve bulut işçisi sırayla işler.

## Özellikler

- Türkçe, duyarlı (responsive) arayüz; küçük ekranlarda alt gezinme, geniş ekranda kenar menüsü.
- PWA manifesti, ana ekrana ekleme düğmesi ve statik arayüz için çevrimdışı önbellek.
- Koyu/açık tema düğmesi ve cihazda saklanan tercih; hareket azaltma erişilebilirlik ayarına saygı.
- Supabase e-posta magic-link girişi; sadece giriş yapan kullanıcı kendi kuyruğunu görür.
- Satır satır Reel linki, `URL | açıklama` biçimi, panodan yapıştırma ve anlık URL doğrulama.
- Aynı Reel shortcode'u daha önce sıradaysa, başarısız olduysa, iptal edildiyse veya yayınlandıysa tekrar eklenmez.
- Kuyruk filtreleri/arama, sayaçlar, durum ve yüzde ilerlemesi; başarısız işi tekrar deneme ve kuyruktan çıkarma.
- Paylaşım hakkı onayı alınmadan yeni kayıt veritabanına eklenmez.
- Instagram erişim anahtarı ve Supabase service-role anahtarı tarayıcı paketinde bulunmaz.

## Parçalar

- `src/` — Vite ile derlenen mobil web arayüzü.
- `supabase/schema.sql` — RLS etkin tablo, dedupe ve kullanıcıya ait iptal/yeniden dene RPC'leri. Bu şema `reels-mobile` projesine zaten uygulandı.
- `../.github/workflows/deploy-mobile-site.yml` — GitHub Pages deploy'u.
- `../.github/workflows/process-reels.yml` ve `../reels_transfer/github_worker.py` — yaklaşık 5 dakikada bir çalışan, kuyruktan **tek** Reel alıp indirip yayımlayan GitHub Actions worker'ı.

GitHub Actions aralığı sadece bekleyen işi kontrol etmek içindir; tekil Reel'lere planlı gönderim saati eklemez. GitHub'ın zamanlanmış Actions tetikleyicileri en iyi çaba esaslıdır, yoğunlukta gecikebilir veya iş düşebilir. Yani "tam dakika garantisi" değildir.

## Geliştirme

```bash
cd mobile-site
npm ci
npm test
npm run dev
npm run build
```

Önizleme adresi Vite tarafından terminalde gösterilir. Supabase e-posta magic-link girişinde, yerel geliştirme adresini Supabase **Authentication → URL Configuration → Redirect URLs** bölümüne ekleyin. Üretimde GitHub Pages adresini de izin listesine ekleyin.

## İlk kullanım ve güvenlik

1. Supabase'te tek yönetici kullanıcı oluşturun (Authentication → Users). Uygulama yeni hesap açmaz; yalnızca önceden oluşturulmuş kullanıcılara magic link yollar.
2. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_OWNER_ID`, `IG_ACCESS_TOKEN`, `IG_USER_ID` GitHub depo **Actions secrets** alanına ekleyin. `SUPABASE_SERVICE_ROLE_KEY` ve Instagram tokenı gizlidir; kaynak dosyaya, Pages'e veya issue/log çıktısına koymayın.
3. Instagram Login ile yerel videoyu Meta'nın okuyabilmesi için `CLOUDINARY_CLOUD_NAME` ve unsigned `CLOUDINARY_UPLOAD_PRESET` secrets'larını da ekleyin. `IG_API_MODE` ve `PUBLIC_UPLOAD_MODE` Actions variables olarak ayarlanabilir. Tokensiz medya indirme, içerik hakkı veya Instagram erişim kısıtlarını aşmaz.
4. GitHub deposunda **Settings → Pages → Build and deployment → GitHub Actions** seçin. `main` dalına aktarım Pages ve worker iş akışlarını devreye alır.
5. Repo Variables içine `REEL_WORKER_ENABLED=true` ekleyince bulut işçisi devreye girer; bu değişken yokken iş akışı paylaşım çalıştırmaz.
6. Siteye magic link ile giriş yapın. URL'leri eklerken içerik paylaşma hakkı kutusunu onaylayın. Worker, GitHub Action secret'ındaki `SUPABASE_OWNER_ID` değerine ait kuyruğu işler.
7. Secrets/variable'lar tamamlanınca `src/config.js` içindeki `PUBLISHER_SETUP_READY` değerini `true` yapıp Pages build'ini yeniden yayınlayın; bu yalnızca paneldeki bağlantı durumunu gösterir.

GitHub Pages için ücretsiz plan koşulları depo görünürlüğüne ve planına göre değişebilir. Ücretsiz Pages hedefleniyorsa kod deposunu herkese açık yapmadan önce görünürlük onayı alın; bu paket tek başına hiçbir depoyu yayımlamaz. Supabase Free projeleri düşük etkinlikte duraklatabilir. GitHub Actions scheduled işleri yoğun saatlerde gecikebilir; herkese açık depolardaki zamanlanmış iş akışları 60 gün etkinlik olmazsa kapanabilir. Ücretsiz katmanlar garanti/SLA sağlamaz.

## Atıf ve kaynak

Üst paneldeki soyut görsel [Unsplash'taki bu sayfadan](https://unsplash.com/photos/abstract-purple-and-blue-glowing-curves-background-xP9nBpGYLyA) alınmıştır; görsel varlığı `public/assets/abstract-purple-blue.jpg` dosyasıdır. [Unsplash lisansı](https://unsplash.com/license) ücretsiz kişisel ve ticari kullanıma izin verir; atıf zorunlu değildir.

- [GitHub Actions schedule tetikleme belgeleri](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [GitHub Pages hakkında](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## Mevcut bağlantı durumu

Supabase `reels-mobile` projesi `eu-central-1` bölgesinde oluşturuldu ve kuyruk şeması uygulandı. Bu klasör GitHub Pages'e henüz yayımlanmamıştır. Yayın işçisi arayüzde kurulum bekliyor olarak görünür; Pages depoyu ve yukarıdaki GitHub Actions secrets'larını kurmadan gerçek Instagram paylaşımı çalıştırılmaz. Instagram Graph API kotası, token süresi ve kaynak videonun herkese açık indirilebilir olması da yayın başarısını etkiler.
