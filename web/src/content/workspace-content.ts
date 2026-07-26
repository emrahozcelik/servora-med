import type { UserRole } from '../services/api';

export type WorkspaceContent = Readonly<{
  id: string;
  title: string;
  summary: string;
  category: 'Başlangıç' | 'İş akışı' | 'Kayıtlar' | 'Bildirimler' | 'Raporlar' | 'Sorun giderme';
  audience: readonly UserRole[];
  updatedLabel: string;
  sections: ReadonlyArray<Readonly<{ heading: string; paragraphs: readonly string[] }>>;
}>;

const everyRole: readonly UserRole[] = ['ADMIN', 'MANAGER', 'STAFF'];

export const productDocumentation: readonly WorkspaceContent[] = [
  {
    id: 'job-flow',
    title: 'İşlerin temel akışı',
    summary: 'Atamadan yönetici onayına kadar JobCard yaşam döngüsü.',
    category: 'İş akışı',
    audience: everyRole,
    updatedLabel: 'U1',
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
    updatedLabel: 'U1',
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
    summary: 'Uygulama içi bildirimler ile bu tarayıcıdaki Web Push durumu.',
    category: 'Bildirimler',
    audience: everyRole,
    updatedLabel: 'U1',
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
    summary: 'Yönetici ve admin rollerinin mevcut operasyon raporları.',
    category: 'Raporlar',
    audience: ['ADMIN', 'MANAGER'],
    updatedLabel: 'U1',
    sections: [{
      heading: 'Yetkili görünüm',
      paragraphs: ['Raporlar yalnız mevcut rol ve organizasyon yetkisi kapsamında gösterilir.'],
    }],
  },
];

export const helpArticles: readonly WorkspaceContent[] = [
  {
    id: 'login-refresh',
    title: 'Oturum açma ve sayfa yenileme',
    summary: 'Oturum veya güncelleme sorunu yaşandığında güvenli ilk adımlar.',
    category: 'Sorun giderme',
    audience: everyRole,
    updatedLabel: 'U1',
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
    updatedLabel: 'U1',
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
    updatedLabel: 'U1',
    sections: [{
      heading: 'Ne zaman destek istemeli?',
      paragraphs: [
        'İşlem rolünüz için kapalıysa yöneticinizden yetki kapsamını doğrulamasını isteyin.',
        'Tekrar denemeye rağmen ağ hatası sürüyorsa ekranda görünen güvenli hata kodunu paylaşın; parola, bildirim anahtarı veya müşteri verisi paylaşmayın.',
      ],
    }],
  },
];
