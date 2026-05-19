INSERT INTO applications (id, name, description, type, status)
VALUES
('vidget', 'VidGet 视频下载器', '面向独立创作者的 AI 视频剪辑和下载工具', 'android', 'active'),
('zhujiaoyun', '助教云', '面向 K12 与培训机构的教学辅导 SaaS 平台', 'web', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, phone, email, created_at, last_login)
VALUES
('user_1001', '王梓涵', '13800008821', 'wangzihan@example.com', NOW() - INTERVAL '40 days', NOW() - INTERVAL '10 minutes'),
('user_1002', '李思源', '13900004412', 'lisiyuan@example.com', NOW() - INTERVAL '18 days', NOW() - INTERVAL '2 hours'),
('user_1003', '张逸辰', '18600000098', 'zhangyichen@example.com', NOW() - INTERVAL '95 days', NOW() - INTERVAL '1 day'),
('user_1004', '刘思琪', '15000007723', 'liusiqi@example.com', NOW() - INTERVAL '12 days', NOW() - INTERVAL '25 minutes'),
('user_1005', '陈宇航', '13700006611', 'chenyuhang@example.com', NOW() - INTERVAL '6 days', NOW() - INTERVAL '3 days'),
('user_1006', '赵欣怡', '15900002210', 'zhaoxinyi@example.com', NOW() - INTERVAL '2 days', NOW() - INTERVAL '5 hours'),
('user_1007', '孙浩然', '18000009904', 'sunhaoran@example.com', NOW() - INTERVAL '66 days', NOW() - INTERVAL '7 minutes'),
('user_1008', '周可欣', '13500003382', 'zhoukexin@example.com', NOW() - INTERVAL '4 days', NOW() - INTERVAL '8 hours'),
('user_1009', '吴梓墨', '17600001145', 'wuzimo@example.com', NOW() - INTERVAL '120 days', NOW() - INTERVAL '11 hours'),
('user_1010', '郑一帆', '18200007708', 'zhengyifan@example.com', NOW() - INTERVAL '28 days', NOW() - INTERVAL '14 hours')
ON CONFLICT (id) DO NOTHING;

INSERT INTO purchases (user_id, app_id, plan, order_no, amount, expired_at, payment_method, status, created_at)
VALUES
('user_1001', 'vidget', 'lifetime', 'WX202605090001', 588.00, NULL, '微信支付', 'paid', NOW() - INTERVAL '2 hours'),
('user_1001', 'zhujiaoyun', 'monthly', 'WX202604180001', 68.00, NOW() + INTERVAL '15 days', '微信支付', 'paid', NOW() - INTERVAL '22 days'),
('user_1002', 'vidget', 'monthly', 'AP202605090002', 168.00, NOW() + INTERVAL '20 days', 'Apple Pay', 'paid', NOW() - INTERVAL '1 day'),
('user_1003', 'zhujiaoyun', 'monthly', 'WX202605080003', 408.00, NOW() + INTERVAL '60 days', '微信支付', 'paid', NOW() - INTERVAL '2 days'),
('user_1004', 'vidget', 'lifetime', 'ALI202605090004', 98.00, NULL, '支付宝', 'paid', NOW() - INTERVAL '3 hours'),
('user_1005', 'vidget', 'monthly', 'ALI202604290005', 588.00, NOW() - INTERVAL '1 day', '支付宝', 'paid', NOW() - INTERVAL '10 days'),
('user_1007', 'vidget', 'lifetime', 'BANK202605090006', 2388.00, NULL, '对公转账', 'paid', NOW() - INTERVAL '5 hours'),
('user_1008', 'zhujiaoyun', 'monthly', 'WX202605090007', 68.00, NOW() + INTERVAL '30 days', '微信支付', 'pending', NOW() - INTERVAL '6 hours'),
('user_1009', 'vidget', 'lifetime', 'ALI202605090008', 1288.00, NULL, '支付宝', 'paid', NOW() - INTERVAL '8 hours'),
('user_1010', 'zhujiaoyun', 'monthly', 'WX202605090009', 68.00, NOW() + INTERVAL '30 days', '微信支付', 'paid', NOW() - INTERVAL '1 day')
ON CONFLICT (order_no) DO NOTHING;

INSERT INTO devices (user_id, app_id, device_id, device_name, last_login)
VALUES
('user_1001', 'vidget', 'iphone-16-pro', 'iPhone 16 Pro', NOW() - INTERVAL '10 minutes'),
('user_1001', 'zhujiaoyun', 'macbook-pro-14', 'MacBook Pro 14"', NOW() - INTERVAL '2 hours'),
('user_1002', 'vidget', 'iphone-15', 'iPhone 15', NOW() - INTERVAL '2 hours'),
('user_1003', 'zhujiaoyun', 'surface-laptop', 'Surface Laptop', NOW() - INTERVAL '1 day'),
('user_1004', 'vidget', 'chrome-win11', 'Chrome · Windows 11', NOW() - INTERVAL '25 minutes'),
('user_1007', 'vidget', 'android-fold', 'Android Fold', NOW() - INTERVAL '7 minutes'),
('user_1007', 'zhujiaoyun', 'ipad-pro', 'iPad Pro', NOW() - INTERVAL '30 minutes'),
('user_1009', 'vidget', 'mac-studio', 'Mac Studio', NOW() - INTERVAL '11 hours')
ON CONFLICT (user_id, app_id, device_id) DO NOTHING;

INSERT INTO landing_pages (app_id, slug, html_path, is_published, published_at, updated_at)
VALUES
('vidget', 'vidget', 'src/uploads/landing/vidget/index.html', true, NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 hours'),
('zhujiaoyun', 'zhujiaoyun', 'src/uploads/landing/zhujiaoyun/index.html', false, NULL, NOW() - INTERVAL '12 hours')
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO app_releases (app_id, type, file_path, file_name, file_size, download_url, version, updated_at)
VALUES
('vidget', 'apk', 'src/uploads/releases/vidget/vidget-apk.apk', 'VidGet-2.4.1-arm64.apk', 48200000, 'http://localhost:3000/download/vidget/apk', '2.4.1', NOW() - INTERVAL '2 hours'),
('vidget', 'exe', 'src/uploads/releases/vidget/vidget-exe.exe', 'VidGet-Setup-2.4.1.exe', 92600000, 'http://localhost:3000/download/vidget/exe', '2.4.1', NOW() - INTERVAL '2 hours'),
('vidget', 'dmg', 'src/uploads/releases/vidget/vidget-dmg.dmg', 'VidGet-2.4.1-universal.dmg', 76400000, 'http://localhost:3000/download/vidget/dmg', '2.4.1', NOW() - INTERVAL '2 hours'),
('zhujiaoyun', 'apk', 'src/uploads/releases/zhujiaoyun/zhujiaoyun-apk.apk', 'ZhuJiao-1.9.3.apk', 32100000, 'http://localhost:3000/download/zhujiaoyun/apk', '1.9.3', NOW() - INTERVAL '12 hours'),
('zhujiaoyun', 'exe', 'src/uploads/releases/zhujiaoyun/zhujiaoyun-exe.exe', 'ZhuJiao-Setup-1.9.3.exe', 68900000, 'http://localhost:3000/download/zhujiaoyun/exe', '1.9.3', NOW() - INTERVAL '12 hours'),
('zhujiaoyun', 'dmg', 'src/uploads/releases/zhujiaoyun/zhujiaoyun-dmg.dmg', 'ZhuJiao-1.9.3.dmg', 54200000, 'http://localhost:3000/download/zhujiaoyun/dmg', '1.9.3', NOW() - INTERVAL '12 hours')
ON CONFLICT (app_id, type) DO NOTHING;
