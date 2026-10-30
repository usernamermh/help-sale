-- 最小权限账号(在 MySQL 上以管理员身份执行一次)
-- 用法:mysql -h <host> -u root -p < scripts/mysql-grants.sql
-- 然后把 help-sale.config.yaml 的 mysql.user/password 换成 help_sale_rw(应用只需要读写业务表,不需要 DDL)。

-- 1) 只读账号:给分析/报表用(把 SQL 工具接成只读时可选)
CREATE USER IF NOT EXISTS 'help_sale_ro'@'%' IDENTIFIED BY '请改成强口令';
GRANT SELECT ON help_sale.* TO 'help_sale_ro'@'%';

-- 2) 读写账号:应用主账号(只有 DML,没有 DDL / 没有跨库权限)
CREATE USER IF NOT EXISTS 'help_sale_rw'@'%' IDENTIFIED BY '请改成强口令';
GRANT SELECT, INSERT, UPDATE, DELETE ON help_sale.* TO 'help_sale_rw'@'%';

FLUSH PRIVILEGES;

-- 注意:
--   * 不要用 root:root 拥有 FILE / PROCESS / 跨库权限,一旦语句层被绕过就是整台 MySQL;
--   * 建表/补列(启动自检)需要 CREATE/ALTER:首次部署可以用管理员账号跑一次,
--     之后把应用切到 help_sale_rw 即可(自检发现缺列会告警,但不会执行 DDL —— 这是刻意的);
--   * 需要更强隔离时,把 SQL 工具的读请求配到 help_sale_ro(只读账号)。