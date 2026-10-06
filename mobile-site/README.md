# ReelFlow — çok kullanıcılı mobil Reels kuyruğu

Telefon, tablet ve masaüstü tarayıcılarında çalışan; ana ekrana kurulabilen PWA paneli. Her kullanıcı kendi e-posta hesabını açar, kendi Instagram profesyonel hesabını Meta'nın OAuth ekranından bağlar ve yalnızca kendi kuyruğundan yayın yapar. Kullanıcı, hesabı bağladıktan sonra yayınlanan Reels'ler arasındaki minimum aralığı seçebilir; içerikler kuyruğa göre sırayla işlenir.

**Canlı panel:** [https://hymenrus.github.io/reels-transfer/](https://hymenrus.github.io/reels-transfer/)

## Özellikler

- Türkçe, duyarlı arayüz; küçük ekranda alt gezinme, geniş ekranda kenar menüsü.
- PWA kurulumu, statik arayüz için çevrimdışı önbellek, koyu/açık tema ve azaltılmış hareket desteği.
- E-posta magic-link ile oturum açma ve yeni kullanıcıların kendi kendine kaydı (Supabase Auth'ta sign-up açık olmalı).
- Her kullanıcının kendi Instagram Business/Creator hesabını Meta OAuth üzerinden bağlaması ve gerektiğinde bağlantıyı kesmesi.
- Hesap başına Reels aralığı: 1 saat, 3 saat, 6 saat, 12 saat, 1 gün veya 2 gün; varsayılan 6 saattir.
- Her hesaba özel, sunucu tarafında saklanan Instagram tokenı; tarayıcı koduna asla gönderilmez.
- Kullanıcıya ait queue/RLS, URL doğrulama ve Reel shortcode'una göre tekrar koruması.
- Arama/filtre, durum ve yüzde ilerlemesi, başarısız işi tekrar deneme ve kuyruktan çıkarma.
- Paylaşım hakkı onayı alınmadan yeni kayıt eklenmez.
- GitHub Actions, kullanıcı başına token/kota kullanır; kuyruk sahipliği her işte doğrulanır ve kullanıcılar arasında sırayla işlem yapılır.

## Parçalar

- `src/` — Vite ile derlenen web/PWA arayüzü.
- `supabase/schema.sql` — yeni kurulum için kuyruk ve Instagram OAuth şeması.
- `supabase/migrations/202610070001_multi_user_instagram.sql` — mevcut projeye eklenecek kullanıcı başına Instagram hesap/token tabloları.
- `supabase/migrations/202610070002_secure_instagram_token_policies.sql` — token/state tablolarına service-role-only RLS ve state indeksi.
- `supabase/migrations/202610070003_publish_interval.sql` — kullanıcıya özel gönderi aralığı ve atomik yayın/cooldown işlemi.
- `supabase/functions/instagram-oauth-*` — Meta Business Login başlatma ve güvenli callback; `instagram-disconnect` — hesabı ayırma.
- `../reels_transfer/github_worker.py` — Supabase kuyruğunu kullanıcıya ait Instagram tokenıyla işleyen worker.
- `../.github/workflows/deploy-mobile-site.yml` — GitHub Pages dağıtımı.
- `../.github/workflows/process-reels.yml` — yaklaşık 5 dakikada bir kuyruğu kontrol eden worker.

GitHub Actions worker'ı yaklaşık 5 dakikada bir kuyruk kontrolü yapar; **bu, her 5 dakikada bir paylaşım yapılacağı anlamına gelmez.** Her kullanıcı için yalnızca seçtiği minimum aralık dolduğunda yeni Reel yayınlanır. İlk yayın uygun olduğunda hemen başlayabilir; sonraki yayınlar seçilen aralıkla ayrılır. Actions tetiklemeleri en iyi çaba esaslıdır; yoğunlukta gecikebilir veya iş düşebilir, tam dakika garantisi yoktur. Kuyruk ilk giren ilk çıkar.

## Geliştirme

```bash
cd mobile-site
npm ci
npm test
npm run dev
npm run build
```

Yerel geliştirme adresini Supabase **Authentication → URL Configuration → Redirect URLs** listesine ekleyin. Üretim yönlendirme adresi `https://hymenrus.github.io/reels-transfer/` olmalı.

## Kurulum: kullanıcı kaydı ve kendi Instagram hesabını bağlama

### 1. Supabase kullanıcı kaydını aç

Magic-link formu `shouldCreateUser: true` kullanır; böylece her kişi kendisi kaydolur, senin tek tek “Add user” yapman gerekmez. Eğer Supabase `Signups not allowed for otp` hatası vermeye devam ederse Supabase Dashboard → **Authentication → Sign In / Providers → Email** bölümünde yeni kullanıcı kayıtlarına izin ver. Uygulamadaki RLS politikaları her kullanıcının kuyruğunu kendi hesabıyla sınırlar.

Supabase Auth → **URL Configuration** içinde Site URL'yi ve `https://hymenrus.github.io/reels-transfer/` adresini Redirect URLs listesine ekle.

### 2. Kullanıcı başına Instagram OAuth veritabanını uygula

Mevcut projeye `supabase/migrations/202610070001_multi_user_instagram.sql` migration'ı uygulanmalı. `instagram_accounts` tablosunda kullanıcı yalnızca kendi bağlantı bilgisini okuyabilir; `instagram_credentials` ve OAuth state tabloları anon/authenticated rollerine kapalıdır ve yalnızca server-side service role tarafından kullanılabilir. Instagram tokenları tarayıcıya dönmez.

`202610070003_publish_interval.sql` migration'ı kullanıcının yalnızca kendi yayın aralığını güncellemesine izin verir; diğer hesap/token alanları server-owned kalır. Seçilen aralık `last_published_at` üzerinden hesaplanır, bu nedenle kullanıcı aralığı değiştirdiğinde yeni değer bekleyen kuyruğa hemen yansır.

### 3. Meta Developer App oluştur ve onaylat

Bu entegrasyon için Meta Developer App içinde **Instagram API with Instagram Login / Business Login** etkin olmalı. App'te şu OAuth redirect URI'yi birebir kaydet:

```text
https://fwscsiswefezkyfblres.supabase.co/functions/v1/instagram-oauth-callback
```

İstenen izinler:

- `instagram_business_basic`
- `instagram_business_content_publish`

Bağlanacak hesap **Business veya Creator** olmalı; kişisel Instagram hesapları bu yayın API'sinde desteklenmiyor. Uygulamayı ekip dışındaki kişilere açmak için Meta'nın istediği Advanced Access/App Review ve varsa işletme doğrulaması gerekebilir. Meta App henüz oluşturulmamış/kimlik bilgileri sağlanmamışsa “Hesabımı bağla” güvenli biçimde kurulum hatası verir; kullanıcı tokenı istemez.

Supabase Dashboard → **Edge Functions → Secrets** bölümünde aşağıdakileri ayarla:

- `INSTAGRAM_APP_ID`
- `INSTAGRAM_APP_SECRET` — gizli tut; Pages/GitHub kaynak koduna koyma.
- `INSTAGRAM_REDIRECT_URI` — yukarıdaki callback adresiyle aynı olmalı.
- `APP_SITE_URL=https://hymenrus.github.io/reels-transfer/`

Supabase function runtime'ının `SUPABASE_URL`, publishable key ve service-role key erişimi de etkin olmalı. OAuth code exchange ve uzun ömürlü token değişimi yalnızca Edge Function tarafında yapılır. Meta long-lived tokenı yaklaşık 60 gün geçerlidir; worker gerektiğinde yeniler. Kullanıcı bağlantıyı keserse token kaydı silinir.

### 4. GitHub Actions worker sırlarını ekle

GitHub deposunda **Settings → Secrets and variables → Actions → Secrets** alanına:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_UPLOAD_PRESET`

ekle. Service-role key ve Cloudinary bilgileri gizlidir; kaynak dosyaya, Pages'e veya loglara koyma. Eski tek-hesap değişkenleri `SUPABASE_OWNER_ID`, `IG_ACCESS_TOKEN`, `IG_USER_ID` artık worker için kullanılmaz. Instagram tokenları kullanıcı bağlandığında Supabase'in özel credentials tablosundan alınır.

Repo **Actions → Variables** alanına, tüm Meta/Supabase/GitHub kurulum ve testleri tamamlandıktan sonra `REEL_WORKER_ENABLED=true` eklenirse zamanlanmış yayın worker'ı etkinleşir. Worker, GitHub Actions üzerinde çalıştığı için kendi bilgisayarının açık kalması gerekmez. Her run en fazla bir Reel işler (workflow varsayılanı); aynı Reel farklı kullanıcıların kendi kuyruklarında bağımsız olabilir. Kurulum tamamlanınca paneldeki durum rozetini göstermek için `mobile-site/src/config.js` içindeki `PUBLISHER_SETUP_READY` değerini `true` yapıp siteyi yeniden dağıt; bu bayrak yalnızca arayüz göstergesidir, sırların yerini tutmaz.

Instagram'ın videoyu alabilmesi için medya kısa süreli herkese açık HTTPS URL'sine yüklenir; bunun için Cloudinary kullanılır. Yalnızca paylaşma hakkına sahip olduğun videoları ekle ve hassas içerik kullanma.

## Mevcut kurulum durumu

Pages arayüzü canlıdır. Bu güncelleme self-signup metnini/akışını, kullanıcı başına Instagram OAuth kodunu, özel token tablolarını ve çok kullanıcılı worker'ı hazırlar. **Meta Developer App henüz yoktur**; bu nedenle OAuth, Meta App ID/Secret ve Meta'nın gerekli erişim onayı eklenmeden gerçek Instagram bağlantısı kuramaz. GitHub Actions secrets da kullanıcı tarafından repo ayarlarından eklenmelidir. Worker `REEL_WORKER_ENABLED=true` değişkeni olmadan yayın yapmaz.

## Kaynaklar

- [Meta Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Meta Instagram content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
- [Supabase Auth settings](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets)
- [GitHub Actions scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## Atıf

Üst paneldeki soyut görsel [Unsplash'taki bu sayfadan](https://unsplash.com/photos/abstract-purple-and-blue-glowing-curves-background-xP9nBpGYLyA) alınmıştır; görsel varlığı `public/assets/abstract-purple-blue.jpg` dosyasıdır. [Unsplash lisansı](https://unsplash.com/license) ücretsiz kişisel ve ticari kullanıma izin verir.
