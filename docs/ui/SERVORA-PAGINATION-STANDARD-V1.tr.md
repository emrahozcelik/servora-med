# SERVORA-MED — Liste ve Sayfalama Standardı v1

**Durum:** DRAFT / REVIEW REQUIRED — 7 Kasım 2026

**Baz alınan main:** `284b618b0bfabe18b5a27bb3b28bc3e2d208e17f`

**Karar:** İlk yüklemede **6 kayıt**. Uzun, arama/filtreleme içeren liste yüzeyleri sınırlı sonuç ve ortak sayfalama kullanmalı. Bu bir sayısal rapor kuralı değişikliği değildir.

## 1. Kaynaklar ve teknoloji

- Mevcut web: React 19.2.7, Ant Design **6.5.1**, `ServoraAntProvider` Türkçe locale, tasarım token'ları ve `servora-ant` prefix'i.
- `web/src/ui/antd/ServoraPagination.tsx` **önceden vardı**; yeni kütüphane veya ikon paketi eklenmez. v1 buna `ServoraListPagination` ekler, eski `ServoraPagination` API'sini korur.
- [Ant Design Icons — tasarım ilkeleri](https://ant.design/docs/spec/icon/): net/flat, tutarlı kontur ve çizgi kalınlığı, görsel düzeltme, metinle orantılı boyut, salt renge dayanmayan anlam. Bu sayfa **bileşen kataloğu değildir**.
- [Ant Design Pagination](https://ant.design/components/pagination/): controlled `current`, `pageSize`, `total`, `simple`, `responsive`, `hideOnSinglePage`, `showSizeChanger`. Hazır yön oklarını kullan; dekoratif ayrı ikon ekleme.
- [Ant Design Table](https://ant.design/components/table/): yalnızca gerçekten tablo/sıralama gerektiren ekranlarda; server-side sayfalama için kontrollü veri ve toplamı kullan.
- Yararlı mevcut bileşenler: `Pagination`, `Table`, `Select` (müşteri seçme), `Tag` (durum), `Tooltip` (teknik açıklamalar), `Empty`/`Skeleton` (yükleme/boş); bunları tüm ekranlara zorla taşımayın.

## 2. v1 sözleşmesi

1. Varsayılan `DEFAULT_LIST_PAGE_SIZE = 6`. İstisna ancak API, güvenlik, karmaşık seçici veya operasyonel gerekçe belgelendirilirse.
2. `limit/offset` destekleyen API'lerde **sunucu tarafı sayfalama** zorunlu. İlk altı kaydı göstermek için tüm kataloğu indirme.
3. Arama sunucu düzeyinde tüm yetkili sonuçlara uygulanmalı. Arama/filtre/değişen kapsam `offset=0` ile başlamalı; yazılmakta olan arama için mevcut gecikmiş istek geçersiz sayılmalı.
4. Sıralama **sayfalamanın öncesinde** uygulanır. Personel gibi tüm veriyi halen döndüren küçük ve yetkili raporlarda, mevcut payload üzerinde sıralama/filtreleme sonrası istemci dilimlemesi ancak geçici ve açıkça belgeli çözüm olabilir.
5. Geçerli offset: negatif olmayan güvenli tamsayı; varsayılan 6'nın katına hizalanır. Eski bookmark offset'leri canonical URL'ye taşınır. Uçuşta eski istek yanıtı en yeni state'i ezemez.
6. Kayıt silinirse ya da filtre sonrası son sayfa boş kalırsa uygun son sayfaya **sınırlı ve döngüsüz** dönüş sağlanır; kullanıcı filtreleri/tarih aralığı korunur.
7. Kontroller: sayfa X/Y, toplam N; Önceki/Sonraki, semantik nav ve klavye erişimi; tek sayfada gizli. 320/390/1440 ve 200%/400% zoom, ekrandan taşma, uzun metin ve azaltılmış hareket kontrolü.
8. Beklenen kullanıcı deneyimi: yükleme/boş/hata durumları, kontrol devre dışı koşulları, odak kaybı, geri/ileri URL navigasyonu ve rol/organizasyon izolasyonu test edilmeli.
9. Gösterilen kayıtlara ait sayısal toplam rapor metriklerini değiştirme. `total` yalnızca doğru izinli sonuç sayısıdır; altı satır raporun toplamını yeniden hesaplamaz.
10. Veri indirme/export, arka plan toplu işlemleri, Kanban, takvim, küçük kapalı seçim menüleri ve bildirim önizlemesi için kendi semantiği korunur; otomatik satır sayısı dayatılmaz.

## 3. Kaynak kod envanteri (başlangıç main'i)

| Yüzey | Yer / mevcut pencere | v1 hedefi / teknik risk | Aşama |
|---|---|---|---|
| **Raporlar / Müşteriler** | `reports/CustomerReport.tsx` / **50** server | 6; URL offset'i kanonikleştir, tarih/filtreyi koru, toplamları bozma | **Bu PR pilot** |
| Müşteriler ana listesi | `CustomerList.tsx` / **5** server | 6; önceki PR'nin arama yarışı, silme ve gerçek Chromium testlerini güncelle | Devam PR |
| Ürünler ana listesi | `ProductList.tsx` / **25** server | 6; eski URL'leri, silme sonrası son sayfayı ve rol durumunu test et | Devam PR |
| Ürün arama/seçme | `ProductSelect.tsx` / **8** server | 6; seçilen ürünleri sayfa geçişinde sakla, çoklu ürün/quantity akışını bozma | Devam PR |
| Raporlar / Personel | `StaffPerformanceReport.tsx` + `StaffPerformanceTable.tsx` / **tüm dönen personel** | 6; desktop tablo ve mobil kartı **aynı** sıralama+sayfa penceresinden üret; staff filtre sonrası sayfa sıfırla | Devam PR |
| Personel iş geçmişi | `StaffProfiles.tsx` / **20** server | 6; açık/tamamlanan sekmesi ve realtime yarış kapısını koru | Devam PR |
| Personel haftalık geçmişi | `StaffProfiles.tsx` / **20** server | 6; PDF indirme/durum geçişi korunmalı | Devam PR |
| İşler / liste | `jobs/JobWorkspace.tsx` / **25** server | 6; Kanban görünümü **hariç**, liste görünümü ve URL durumu | Devam PR |
| Raporlar / Onay | `reports/ApprovalReport.tsx` / **50** server | 6; onay kuyruğunda sıralama ve yönetici aksiyonları | Devam PR |
| Raporlar / Teslimat | `reports/DeliveryReport.tsx` / **50** server | 6; `groupBy`, personel filtresi, dönem ve toplam tutarlılığı | Devam PR |
| Raporlar / Satış-takip | `reports/SalesFollowUpReport.tsx` / **10+10** server | 6+6; iki **bağımsız** offset ve tablo genişletme durumu; Ant Table kendi paginator'ı ile çifte paginasyon üretme | Devam PR |
| İş oluştururken müşteri seçimi | `jobs/CustomerSearchSelect.tsx` / **20 append** | `Select` arama/klavye etkileşimi, devam yüklemesi, id ile seçilmiş kaydı tutma: klasik 6'ya hemen çevirmeden ayrı tasarım/UX testi | İstisna değerlendirmesi |
| Kullanıcı/personel yönetimi | `UserManagement.tsx` / toplu `listUsers()` | 6 için API sayfalama, arama ve yetki tasarımı gerekebilir; tüm kayıtları indirmeyi 6 göstererek gizleme | API tasarımı |
| Müşteri bağlantılı kişiler | `ContactManagement.tsx` / müşteri detay alt listesi | Kapsama bağlı; az kayıt varsa bölmemek daha kullanışlı | İstisna |
| Tekrarlı müşteri adayları | `DuplicateCustomers.tsx` / cursor pagination | Cursor sözleşmesini `offset` ile değiştirme; 6'nın uygulanabilirliğini ayrıca araştır | İstisna |
| Bildirimler, takvim, iş panosu | Ayrı kaynaklar | Bildirim görünümü ve Kanban/takvim semantiğine dokunma | Kapsam dışı |

**Envanter notu:** Bu tablo kodun statik incelemesidir; tüm uçtan uca davranışların tarayıcıda yeniden doğrulandığı anlamına gelmez.

## 4. Ant Design seçimi ve ikon dili

- **Kullan:** `ServoraListPagination` (Ant `Pagination`, controlled, simple read-only, size changer kapalı, Türkçe status, mevcut `ConfigProvider` üzerinden locale).
- **Kontrollü:** `Table` yalnızca tablo sıralama/expanded-row semantiği gerektiğinde. Hem AntD Table otomatik paginasyonu hem harici sayfalama birlikte etkinleştirilmez.
- **Mevcut:** `Select` / arama bileşenleri; kullanıcının seçtiği öğe sayfa değiştirdiğinde kaybolmamalı.
- **İkonlar:** Ant built-in Prev/Next okları; ikon tek başına bilgi/aksiyon açıklaması sayılmaz. Silme, dışa aktarma, filtre, temizle ikonları gerektiğinde metin veya aria-label zorunlu. Rastgele emoji, karışık SVG stroke ve üçüncü ikon seti getirme.
- **Tasarım:** varsayılan responsive/compact, odak görünürlüğü, yeterli dokunma alanı, 320px ekran ve 400% yakınlaştırma doğrulaması şart. Ant bileşen kullanımının otomatik olarak WCAG uyumu kanıtlamadığını belirt.

## 5. Uygulama fazları

- **Faz A — bu Draft PR:** ortak pure sayfalama yardımcıları + mevcut Ant sarmalayıcıya kontrollü UI standardı + `Raporlar/Müşteriler` pilotu + regresyon testleri; **backend sözleşmesi, tarih hesabı, migration değişmez**.
- **Faz B:** ana Müşteriler + Ürünler + ürün seçicisi. Sabit 6'ya dönüşüm sırasında eski 5'li Chromium fixture ve ürün seçici testleri gerçek sayfa geçişiyle güncellenmeli.
- **Faz C:** personel raporu/haftalık geçmiş, iş listesi ve rapor onay/teslim/satış-takip. Mümkün olduğunca bağımsız ve küçük PR'ler.
- **Faz D:** yönetim listesi/API sayfalama, cursor ve erişilebilirlik değerlendirmesi; yalnızca gerekirse yeni API.
- Fazların hiçbirini bir sonraki faz otomatik yetkilendirilmiş sayma. Exact SHA CI, Chromium 320/390/1440, gerektiğinde gerçek 400% zoom ve ekran okuyucu kabulünü ayrı raporla.

## 6. Bu PR için kabul

1. Yeni `DEFAULT_LIST_PAGE_SIZE` **6**, güvenli negatif/kesirli/unsafe offset testleri PASS.
2. Müşteri raporu API isteği `limit: 6`; `offset=50` bookmark'ı `48`'e kanonikleştirilir.
3. Çok sayfa: doğru toplam ve sayfa göstergesi. 0..6 sonuçta pager gizli. Filtre/değişen tarih aralığında offset 0.
4. 7 ve 13 kayıt, son sayfanın silinmesi, yarışan istekler, 320/390/1440, 200%/400% zoom; eski rapor sayısal anlamı ve gizlilik değişmez.
5. Web build, tam web testleri, responsive smoke, bundle, GitHub exact-head CI PASS; manuel ekran okuyucu/fiziksel cihaz sonucu varsa ayrıca belirt.
6. Bu PR **Draft**. Başarı kanıtı olmadan merge/deploy yok.

**Not:** Kod değişiklikleri sunucu API limit üst sınırını değiştirmez. Raporların alt kümeye ayrılması, tüm dönem için gösterilen toplamların altı öğeye göre yeniden hesaplanması anlamına gelmez.
