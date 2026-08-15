# P2P Monitoring Bot (Wallet + Bybit)
FROM node:20-alpine

WORKDIR /app

# Ставим зависимости сначала (лучше кэширование слоёв)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Исходники приложения
COPY index.js ./

# Секреты НЕ зашиваем в образ — они передаются через docker-compose env_file (.env)
ENV NODE_ENV=production

# Запуск от непривилегированного пользователя (приложение не пишет файлы)
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
