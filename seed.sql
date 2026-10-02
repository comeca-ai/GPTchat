INSERT OR IGNORE INTO snapshots (id,published_at,source_url,r2_prefix,status,company_count)
VALUES ('demo-2026-09','2026-09-01','https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica-cnpj','snapshots/2026-09/','ready',2);

INSERT OR IGNORE INTO cnae VALUES
('6201501','Desenvolvimento de programas de computador sob encomenda','desenvolvimento de programas de computador sob encomenda'),
('5611201','Restaurantes e similares','restaurantes e similares');

INSERT OR IGNORE INTO companies VALUES
('00000000','BANCO DO BRASIL SA','banco do brasil sa','2038','DEMAIS',120000000000,'demo-2026-09'),
('12345678','TECNOLOGIA EXEMPLO LTDA','tecnologia exemplo ltda','2062','ME',10000000,'demo-2026-09');

INSERT OR IGNORE INTO establishments VALUES
('00000000000191','00000000','DIRECAO GERAL','direcao geral',2,NULL,'6422100','5300108','BRASILIA','DF','1966-08-01','demo-2026-09'),
('12345678000199','12345678','EXEMPLO TECH','exemplo tech',2,NULL,'6201501','5208707','GOIANIA','GO','2020-01-10','demo-2026-09');

INSERT OR IGNORE INTO partners (cnpj_base,partner_name,qualification,joined_at,snapshot_id)
VALUES ('12345678','MARIA EXEMPLO','Sócio-Administrador','2020-01-10','demo-2026-09');

INSERT OR IGNORE INTO simples VALUES ('12345678',1,0,'2020-01-10',NULL,'demo-2026-09');
