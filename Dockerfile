FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p src/uploads/releases src/uploads/landing

EXPOSE 3000

CMD ["npm", "start"]
