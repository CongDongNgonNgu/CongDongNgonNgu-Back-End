INSERT INTO languages (
  code,
  slug,
  native_name,
  english_name,
  vietnamese_name,
  direction,
  active,
  launch,
  sort_order
)
VALUES
  ('vi', 'vietnamese', 'Tiếng Việt', 'Vietnamese', 'Tiếng Việt', 'ltr', true, true, 10),
  ('en', 'english', 'English', 'English', 'Tiếng Anh', 'ltr', true, true, 20),
  ('zh', 'chinese', '中文', 'Chinese', 'Tiếng Trung', 'ltr', true, true, 30),
  ('ja', 'japanese', '日本語', 'Japanese', 'Tiếng Nhật', 'ltr', true, true, 40),
  ('ko', 'korean', '한국어', 'Korean', 'Tiếng Hàn', 'ltr', true, true, 50),
  ('fr', 'french', 'Français', 'French', 'Tiếng Pháp', 'ltr', true, true, 60),
  ('de', 'german', 'Deutsch', 'German', 'Tiếng Đức', 'ltr', true, true, 70),
  ('es', 'spanish', 'Español', 'Spanish', 'Tiếng Tây Ban Nha', 'ltr', true, true, 80)
ON CONFLICT (code) DO UPDATE SET
  slug = EXCLUDED.slug,
  native_name = EXCLUDED.native_name,
  english_name = EXCLUDED.english_name,
  vietnamese_name = EXCLUDED.vietnamese_name,
  direction = EXCLUDED.direction,
  active = EXCLUDED.active,
  launch = EXCLUDED.launch,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
