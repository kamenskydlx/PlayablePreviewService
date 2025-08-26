# 🚀 Развертывание на VPS

Пошаговый гайд по развертыванию Playable Preview Service на чистом VPS.

## 📋 Предварительные требования

- Чистый VPS (Ubuntu 20.04+ / CentOS 8+ / Debian 11+)
- SSH доступ к серверу
- Домен (опционально, но рекомендуется)
- 1GB RAM минимум

## 🛠️ Шаг 1: Подключение к серверу

```bash
# Подключаемся к VPS
ssh root@your-server-ip

# Обновляем систему
apt update && apt upgrade -y
```

## 🐳 Шаг 2: Установка Docker

```bash
# Устанавливаем Docker (включает Docker Compose v2)
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Добавляем пользователя в группу docker (если не root)
usermod -aG docker $USER

# Проверяем установку
docker --version
docker compose version

# Примечание: используем 'docker compose' (без дефиса), а не устаревший 'docker-compose'
```

## 📁 Шаг 3: Загрузка проекта на сервер

### Вариант A: Через Git (рекомендуется)

```bash
# Самый простой вариант для root - папка в домашней директории
mkdir -p ~/playable-preview
cd ~/playable-preview

# Загружаем код (замените на ваш репозиторий)
git clone https://github.com/your-username/playable-preview-service.git .
```

### Вариант B: Через SCP (если нет Git)

На локальной машине:
```bash
# Архивируем проект (исключая node_modules)
tar -czf playable-preview.tar.gz --exclude=node_modules .

# Загружаем на сервер
scp playable-preview.tar.gz root@your-server-ip:~/

# На сервере
cd ~
tar -xzf playable-preview.tar.gz
mv playable-preview-service playable-preview
cd playable-preview
```

### Вариант C: Ручное создание файлов

Если проект не в Git, создаем файлы вручную:

```bash
mkdir -p ~/playable-preview
cd ~/playable-preview

# Создаем структуру
mkdir -p src views public/styles uploads temp
```

Затем скопируйте содержимое файлов с локальной машины.

## ⚙️ Шаг 4: Настройка окружения

```bash
cd ~/playable-preview

# Создаем .env файл
cp .env.example .env

# Редактируем настройки
nano .env
```

Настройте `.env`:
```env
# Замените на ваш надежный пароль
ADMIN_PASSWORD=your_super_secure_password_123

# Замените на ваш домен (или IP)
BASE_URL=https://playable.yourdomain.com

# Порт (по умолчанию 3000)
PORT=3000
```

## 🚀 Шаг 5: Запуск сервиса

```bash
# Запускаем в фоновом режиме
docker compose up -d

# Проверяем статус
docker compose ps

# Смотрим логи
docker compose logs -f
```

## 🌐 Шаг 6: Настройка домена (опционально)

### С Nginx Proxy Manager (рекомендуется)

```bash
# Создаем docker-compose.yml для Nginx Proxy Manager
cat > /opt/nginx-proxy/docker-compose.yml << 'EOF'
version: '3.8'

services:
  nginx-proxy-manager:
    image: 'jc21/nginx-proxy-manager:latest'
    restart: unless-stopped
    ports:
      - '80:80'
      - '81:81'
      - '443:443'
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt

networks:
  default:
    external: true
    name: playablepreviewservice_default
EOF

# Создаем папку и запускаем
mkdir -p ~/nginx-proxy
cd ~/nginx-proxy
docker compose up -d
```

**Настройка через веб-интерфейс:**
1. Откройте `http://your-server-ip:81`
2. Логин: `admin@example.com`, пароль: `changeme`
3. Создайте Proxy Host:
   - Domain: `playable.yourdomain.com`
   - Forward to: `playable-preview-service:3000`
   - Enable SSL

### С обычным Nginx

```bash
# Устанавливаем Nginx
apt install nginx -y

# Создаем конфиг
cat > /etc/nginx/sites-available/playable << 'EOF'
server {
    listen 80;
    server_name playable.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

# Активируем сайт
ln -s /etc/nginx/sites-available/playable /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Устанавливаем SSL с Certbot
apt install certbot python3-certbot-nginx -y
certbot --nginx -d playable.yourdomain.com
```

## 🔒 Шаг 7: Настройка файрвола

```bash
# UFW (Ubuntu/Debian)
ufw allow 22    # SSH
ufw allow 80    # HTTP
ufw allow 443   # HTTPS
ufw allow 3000  # Прямой доступ к приложению (опционально)
ufw enable

# Или iptables
iptables -A INPUT -p tcp --dport 22 -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
iptables-save > /etc/iptables/rules.v4
```

## 📊 Шаг 8: Мониторинг и управление

### Полезные команды

```bash
# Статус сервисов
docker compose ps

# Логи
docker compose logs -f playable-preview

# Перезапуск
docker compose restart

# Остановка
docker compose down

# Обновление
git pull && docker compose up -d --build

# Бэкап данных
tar -czf backup-$(date +%Y%m%d).tar.gz uploads/

# Очистка Docker
docker system prune -f
```

### Автоматические бэкапы

```bash
# Создаем скрипт бэкапа
cat > ~/backup.sh << 'EOF'
#!/bin/bash
cd ~/playable-preview
tar -czf "~/backups/backup-$(date +%Y%m%d-%H%M).tar.gz" uploads/
find ~/backups/ -name "backup-*.tar.gz" -mtime +7 -delete
EOF

chmod +x ~/backup.sh
mkdir -p ~/backups

# Добавляем в crontab (каждый день в 3 утра)
echo "0 3 * * * ~/backup.sh" | crontab -
```

## 🔧 Шаг 9: Настройка логирования

```bash
# Настройка ротации логов
cat > /etc/logrotate.d/docker << 'EOF'
/var/lib/docker/containers/*/*.log {
    rotate 7
    daily
    compress
    size=10M
    missingok
    delaycompress
    copytruncate
}
EOF
```

## ✅ Шаг 10: Проверка работы

1. **Доступность сервиса:**
   ```bash
   curl http://localhost:3000
   # или
   curl https://playable.yourdomain.com
   ```

2. **Логин в админку:**
   - Откройте `https://playable.yourdomain.com/admin`
   - Введите пароль из `.env`

3. **Тест загрузки:**
   - Загрузите тестовый HTML файл
   - Проверьте генерацию QR кода

## 🆘 Устранение проблем

### Сервис не запускается
```bash
# Проверяем логи
docker compose logs

# Проверяем порты
netstat -tlnp | grep 3000

# Проверяем Docker
docker ps -a
```

### Не работает домен
```bash
# Проверяем DNS
nslookup playable.yourdomain.com

# Проверяем Nginx
nginx -t
systemctl status nginx
```

### Проблемы с SSL
```bash
# Обновляем сертификаты
certbot renew --dry-run
```

## 🔄 Обновление сервиса

```bash
cd ~/playable-preview

# Сохраняем данные
docker compose down
cp .env .env.backup

# Обновляем код
git pull
# или загружаем новые файлы

# Перезапускаем
docker compose up -d --build

# Проверяем
docker compose ps
```

## 🎉 Готово!

Ваш Playable Preview Service успешно развернут и готов к работе!

- **Админка:** `https://playable.yourdomain.com/admin`
- **API:** `https://playable.yourdomain.com/api/*`
- **Просмотр:** `https://playable.yourdomain.com/view/{id}`

### Следующие шаги:
1. Настройте регулярные бэкапы
2. Добавьте мониторинг (Uptime Robot, Pingdom)
3. Настройте уведомления об ошибках
4. Регулярно обновляйте Docker образы