FROM node:18-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package.json ./
RUN npm install --production

# Копируем все необходимые файлы
COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/

# Создаем директории для данных
RUN mkdir -p uploads temp

# Открываем порт
EXPOSE 3000

# Запускаем приложение
CMD ["npm", "start"]