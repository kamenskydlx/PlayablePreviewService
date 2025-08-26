FROM node:18-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package.json ./
RUN npm install --production

# Копируем исходный код
COPY src/ ./src/

# Создаем директории
RUN mkdir -p uploads public temp

# Открываем порт
EXPOSE 3000

# Запускаем приложение
CMD ["npm", "start"]