import type { UserRole } from '../services/api';

export type WorkspaceContent = Readonly<{
  id: string;
  title: string;
  summary: string;
  category: 'Başlangıç' | 'İş akışı' | 'Kayıtlar' | 'Bildirimler' | 'Raporlar' | 'Sorun giderme';
  audience: readonly UserRole[];
  sections: ReadonlyArray<Readonly<{ heading: string; paragraphs: readonly string[] }>>;
}>;

const everyRole: readonly UserRole[] = ['ADMIN', 'MANAGER', 'STAFF'];

export const productDocumentation: readonly WorkspaceContent[] = [
  {
    id: 'calendar-planning',
    title: 'Takvim ve planlama',
    summary: 'İş planları, kişisel operasyon planları ve yaklaşan çalışma bildirimleri.',
    category: 'İş akışı',
    audience: everyRole,
    sections: [{
      heading: 'İş ve kişisel plan ayrımı',
      paragraphs: [
        'İş etiketi taşıyan kayıtlar iş kaydı olarak yönetilir; işin durumunu veya yetkisini Takvim değiştirmez.',
        'Kişisel plan etiketi taşıyan kayıtlar Takvim içinde oluşturulur, düzenlenir veya gerekçeyle iptal edilir.',
        'Çakışma uyarısında taslağınız korunur. Başka biri kaydı değiştirdiyse güncel veriyi yükleyip tekrar deneyin.',
      ],
    }, {
      heading: 'Yetki ve bildirim',
      paragraphs: [
        'Personel yalnız kendi takvimini görür. Yönetici yalnız mevcut ekip ilişkisindeki aktif personeli, sistem yöneticisi ise organizasyondaki aktif personeli planlayabilir.',
        'Yaklaşan plan bildirimleri başlık, müşteri açıklaması veya serbest metin taşımaz; kayıt uygulamada yetkili bağlantıdan açılır.',
      ],
    }],
  },
  {
    id: 'job-flow',
    title: 'İşlerin temel akışı',
    summary: 'Atamadan yönetici onayına kadar iş kaydının yaşam döngüsü.',
    category: 'İş akışı',
    audience: everyRole,
    sections: [{
      heading: 'İş nasıl ilerler?',
      paragraphs: [
        'İşler atanır, personel tarafından kabul edilir ve uygulanır.',
        'Personel işi kontrole gönderir; tamamlanma kararı yönetici onayından sonra verilir.',
        'Düzeltme istenirse gerekçe iş ayrıntısında görünür ve kayıt korunur.',
      ],
    }],
  },
  {
    id: 'records',
    title: 'Müşteri, kişi ve ürün kayıtları',
    summary: 'Operasyon işlerinde kullanılan temel kayıtların ayrımı.',
    category: 'Kayıtlar',
    audience: everyRole,
    sections: [{
      heading: 'Kayıt sahipliği',
      paragraphs: [
        'Müşteri; klinik, hastane, bayi veya şirket kaydıdır.',
        'İlgili kişi, müşteriye bağlı doktor, sekreter veya satın alma sorumlusudur.',
        'Ürün kataloğu SKU, marka, model ve izleme bilgilerini ayrı alanlarda tutar.',
      ],
    }],
  },
  {
    id: 'notifications',
    title: 'Bildirim merkezi ve cihaz bildirimleri',
    summary: 'Uygulama içi bildirimler ile bu tarayıcıdaki cihaz bildirimi durumu.',
    category: 'Bildirimler',
    audience: everyRole,
    sections: [{
      heading: 'İki ayrı kanal',
      paragraphs: [
        'Bildirim merkezi uygulama içindeki kayıtları gösterir.',
        'Cihaz bildirimi yalnız bu tarayıcı ve cihazdaki aboneliği açar veya kapatır.',
      ],
    }],
  },
  {
    id: 'reports',
    title: 'Raporlara erişim',
    summary: 'Sistem yöneticisi ve yönetici rollerinin mevcut operasyon raporları.',
    category: 'Raporlar',
    audience: ['ADMIN', 'MANAGER'],
    sections: [{
      heading: 'Yetkili görünüm',
      paragraphs: ['Raporlar yalnız mevcut rol ve organizasyon yetkisi kapsamında gösterilir.'],
    }],
  },
];

export const helpArticles: readonly WorkspaceContent[] = [
  {
    id: 'calendar-help',
    title: 'Takvim kaydı görünmüyor veya kaydedilemiyor',
    summary: 'Yetki, çakışma, güncel sürüm ve bildirim durumunu ayırt etme.',
    category: 'Sorun giderme',
    audience: everyRole,
    sections: [{
      heading: 'Güvenli kontrol sırası',
      paragraphs: [
        'Doğru haftada ve doğru personel filtresinde olduğunuzu kontrol edin; personel rolünde filtre her zaman kendi hesabınıza sabittir.',
        'Çakışma uyarısında listelenen güvenli zaman aralığını inceleyin ve başlangıç veya bitiş saatini değiştirin.',
        'Kayıt başka bir kullanıcı tarafından değiştirildiyse sayfayı yenileyin. Sorun sürerse yalnız hata kodunu paylaşın; plan açıklamasını veya müşteri bilgisini destek mesajına kopyalamayın.',
      ],
    }],
  },
  {
    id: 'login-refresh',
    title: 'Oturum açma ve sayfa yenileme',
    summary: 'Oturum veya güncelleme sorunu yaşandığında güvenli ilk adımlar.',
    category: 'Sorun giderme',
    audience: everyRole,
    sections: [{
      heading: 'Deneyebileceğiniz adımlar',
      paragraphs: [
        'Bağlantınızı kontrol edin ve sayfayı bir kez yenileyin.',
        'Parolanızı veya oturum bilgilerinizi destek ekibi dahil hiç kimseyle paylaşmayın.',
      ],
    }],
  },
  {
    id: 'push-help',
    title: 'Cihaz bildirimi gelmiyor',
    summary: 'Tarayıcı izni ve mevcut cihaz aboneliğini kontrol etme.',
    category: 'Sorun giderme',
    audience: everyRole,
    sections: [{
      heading: 'Cihaz kapsamı',
      paragraphs: [
        'Ayarlar > Bildirimler bölümünde tarayıcı desteğini, izni ve bu cihazın abonelik durumunu kontrol edin.',
        'Bir cihazı kapatmak diğer cihazlarınızdaki abonelikleri değiştirmez.',
      ],
    }],
  },
  {
    id: 'permissions-network',
    title: 'Yetki veya ağ nedeniyle görünmeyen işlemler',
    summary: 'Bir işlem görünmediğinde rol ve bağlantı durumunu ayırt etme.',
    category: 'Sorun giderme',
    audience: everyRole,
    sections: [{
      heading: 'Ne zaman destek istemeli?',
      paragraphs: [
        'İşlem rolünüz için kapalıysa yöneticinizden yetki kapsamını doğrulamasını isteyin.',
        'Tekrar denemeye rağmen ağ hatası sürüyorsa ekranda görünen güvenli hata kodunu paylaşın; parola, bildirim anahtarı veya müşteri verisi paylaşmayın.',
      ],
    }],
  },
];
