INSERT INTO applications (id, name, description, type, status)
VALUES
('vidget', 'VidGet', 'AI video clip and download tool for creators', 'android', 'active'),
('zhujiaoyun', 'ZhuJiaoYun', 'Teaching assistant SaaS platform', 'web', 'active')
ON CONFLICT (id) DO NOTHING;
