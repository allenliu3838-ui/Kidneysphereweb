// Free video library (Bilibili embeds)
//
// IMPORTANT:
// - We only embed the official Bilibili player.
// - We do NOT download, copy, or redistribute video content.
// - If a link is incorrect, mark `needs_check: true` and fix later.

export const VIDEO_CATEGORIES = [
  { key: 'glom',    zh: '肾小球与间质性肾病',                     en: 'Glomerular & Interstitial' },
  { key: 'tx',      zh: '肾移植内科',                             en: 'Transplant Medicine' },
  { key: 'icu',     zh: '重症肾内（电解质/酸碱）与透析',           en: 'Critical · Electrolyte/AB · Dialysis' },
  { key: 'peds',    zh: '儿童肾脏病',                             en: 'Pediatric Nephrology' },
  { key: 'rare',    zh: '罕见肾脏病',                             en: 'Rare Kidney Diseases' },
  { key: 'meeting', zh: '病例讨论会议',                           en: 'Case Meetings' },
  { key: 'path',    zh: '肾脏病理',                               en: 'Renal Pathology' },
  { key: 'other',   zh: '其他肾脏病',                             en: 'Other' },
];

// Each item:
// - id: stable internal id
// - bvid: Bilibili BV id
// - title: video title
// - speaker: speaker / host
// - category: one of VIDEO_CATEGORIES.key
// - source_url: the original Bilibili page
// - needs_check: flag for possibly incorrect links

export const FREE_VIDEOS = [
  {
    id: 'glom-iga-2025-glassock',
    bvid: 'BV1jjmZByEfu',
    title: '应对IgA肾病治疗的动态格局：2025',
    speaker: 'Dr. Glassock',
    category: 'glom',
    source_url: 'https://www.bilibili.com/video/BV1jjmZByEfu/',
  },
  {
    id: 'glom-ln-rovin',
    bvid: 'BV1YNqSBXEkz',
    title: '狼疮肾病诊疗的前沿进展',
    speaker: 'Dr. Brad Rovin',
    category: 'glom',
    source_url: 'https://www.bilibili.com/video/BV1YNqSBXEkz/',
  },
  {
    id: 'glom-tma-java',
    bvid: 'BV1G2moBNE48',
    title: 'TMA的诊疗进展',
    speaker: 'Dr. Anuja Java',
    category: 'glom',
    source_url: 'https://www.bilibili.com/video/BV1G2moBNE48/',
  },
  {
    id: 'glom-fsgs-glassock',
    bvid: 'BV19CmoBKELF',
    title: 'FSGS的最新诊疗进展',
    speaker: 'Dr. Glassock',
    category: 'glom',
    source_url: 'https://www.bilibili.com/video/BV19CmoBKELF/',
  },
  {
    id: 'glom-podocytopathy-rennke',
    bvid: 'BV19Wm2BuEej',
    title: '足细胞病',
    speaker: 'Dr. Helmut G. Rennke',
    category: 'glom',
    source_url: 'https://www.bilibili.com/video/BV19Wm2BuEej/',
  },
  {
    id: 'glom-amyloidosis-li',
    bvid: 'BV1Qtm2BiEKS',
    title: '肾脏淀粉样变的最新进展',
    speaker: '李汀婷 教授',
    category: 'glom',
    source_url: 'https://www.bilibili.com/video/BV1Qtm2BiEKS/',
  },
  {
    id: 'tx-pregnancy-josephson',
    bvid: 'BV1nKmGB9EL1',
    title: '移植与妊娠：三部曲',
    speaker: 'Dr. Josephson',
    category: 'tx',
    source_url: 'https://www.bilibili.com/video/BV1nKmGB9EL1/',
  },
  {
    id: 'path-mgrs-bijol',
    bvid: 'BV1G4kmBbEsA',
    title: 'MGRS的病理诊断',
    speaker: 'Dr. Vanesa Bijol',
    category: 'path',
    source_url: 'https://www.bilibili.com/video/BV1G4kmBbEsA/',
  },
  {
    id: 'tx-xenotransplant-cooper',
    bvid: 'BV1epmZBzEnu',
    title: '异种肾移植的前沿进展',
    speaker: 'Dr. David K.C. Cooper',
    category: 'tx',
    source_url: 'https://www.bilibili.com/video/BV1epmZBzEnu/',
  },
  {
    id: 'path-basics-1-stillman',
    bvid: 'BV1aqm8BxEba',
    title: '肾脏病理学基本原理 - Part 1',
    speaker: 'Dr. Stillman',
    category: 'path',
    source_url: 'https://www.bilibili.com/video/BV1aqm8BxEba/',
  },
  {
    id: 'path-basics-2-stillman',
    bvid: 'BV1aqm8BxEAs',
    title: '肾脏病理学基本原理 - Part 2',
    speaker: 'Dr. Stillman',
    category: 'path',
    source_url: 'https://www.bilibili.com/video/BV1aqm8BxEAs/',
  },
  {
    id: 'path-basics-3-stillman',
    bvid: 'BV1aqm8BxE3b',
    title: '肾脏病理学基本原理 - Part 3',
    speaker: 'Dr. Stillman',
    category: 'path',
    source_url: 'https://www.bilibili.com/video/BV1aqm8BxE3b/',
  },
  {
    id: 'other-pkd-dahl',
    bvid: 'BV1HAmGBdE1M',
    title: '多囊肾的最新诊断和治疗',
    speaker: 'Dr. Dahl',
    category: 'other',
    source_url: 'https://www.bilibili.com/video/BV1HAmGBdE1M/',
  },
];

export function getVideoById(id){
  return FREE_VIDEOS.find(v => v.id === id) || null;
}

export function getCategoryMeta(key){
  return VIDEO_CATEGORIES.find(c => c.key === key) || null;
}
