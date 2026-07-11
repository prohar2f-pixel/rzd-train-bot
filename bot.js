require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // РЖД API
  RZD_API: 'https://pass.rzd.ru/timetable/public/ru',

  // Коды станций
  FROM: '2000000',  // Москва
  TO: '2078001',    // Симферополь

  // Даты поиска
  DATES: ['2026-07-13', '2026-07-14', '2026-07-15'],

  CHECK_INTERVAL: '*/10 * * * *'
};

if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ ОШИБКА: TELEGRAM_TOKEN и TELEGRAM_CHAT_ID обязательны');
  process.exit(1);
}

const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
let foundTickets = new Set();

async function makeRequest(params) {
  try {
    const response = await axios.get(CONFIG.RZD_API, {
      params: params,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    return response.data;
  } catch (error) {
    console.error(`  ❌ Ошибка запроса: ${error.message}`);
    return null;
  }
}

async function searchTickets() {
  try {
    console.log(`\n[${new Date().toLocaleString()}] 🔍 ПРОВЕРКА БИЛЕТОВ РЖД API`);

    for (const date of CONFIG.DATES) {
      try {
        const dateObj = new Date(date);
        const dateStr = dateObj.getDate().toString().padStart(2, '0') + '.' +
                       (dateObj.getMonth() + 1).toString().padStart(2, '0') + '.' +
                       dateObj.getFullYear();

        console.log(`\n  📅 ${dateStr}`);

        // Первый запрос - получить SESSION_ID
        const req1Params = {
          'layer_id': 5371,
          'dir': 0,
          'tfl': 3,  // Дальние поезда
          'checkSeats': 1,  // Проверять только с билетами
          'st0': CONFIG.FROM,
          'st1': CONFIG.TO,
          'dt0': dateStr
        };

        console.log(`    ⏳ Запрос 1 (создание сессии)...`);
        const result1 = await makeRequest(req1Params);

        if (!result1) {
          console.log(`    ⚠️  Пустой ответ`);
          continue;
        }

        const sessionId = result1.result?.sessionID;
        const trainList = result1.result?.trains || [];

        console.log(`    ✓ Получена сессия: ${sessionId}`);
        console.log(`    ✓ Найдено поездов в ответе: ${trainList.length}`);

        if (trainList.length === 0) {
          console.log(`    ℹ️  На эту дату нет поездов`);
          continue;
        }

        // Дождаться обработки
        await new Promise(r => setTimeout(r, 3000));

        // Второй запрос - получить подробную информацию
        const req2Params = {
          'layer_id': 5371,
          'dir': 0,
          'tfl': 3,
          'checkSeats': 1,
          'st0': CONFIG.FROM,
          'st1': CONFIG.TO,
          'dt0': dateStr,
          'rid': result1.result?.RID
        };

        console.log(`    ⏳ Запрос 2 (получение билетов)...`);
        const result2 = await makeRequest(req2Params);

        if (!result2 || !result2.result || !result2.result.trains) {
          console.log(`    ⚠️  Нет результатов во втором запросе`);
          continue;
        }

        const trains = result2.result.trains;
        console.log(`    ✓ Всего поездов: ${trains.length}`);

        // Фильтруем по плацкартам
        let plackartFound = false;

        for (const train of trains) {
          const trainNumber = train.number || train.train;
          const departure = train.departure || train.startTime;
          const arrival = train.arrival || train.endTime;

          // Ищем вагоны с плацкартом
          const cars = train.cars || [];

          for (const car of cars) {
            if (car.type === 6 || car.typeLoc?.includes('плацкарт') || car.typeLoc?.includes('Плацкарт')) {
              const seatsAvailable = car.freeSeats || car.avail || 0;

              if (seatsAvailable > 0) {
                console.log(`    🎉 ПЛАЦКАРТ НАЙДЕН!`);
                console.log(`       Поезд: ${trainNumber}`);
                console.log(`       Отправление: ${departure}`);
                console.log(`       Прибытие: ${arrival}`);
                console.log(`       Свободных мест: ${seatsAvailable}`);

                plackartFound = true;

                const ticketKey = `${dateStr}-${trainNumber}`;
                if (!foundTickets.has(ticketKey)) {
                  foundTickets.add(ticketKey);
                  await notifyAboutTickets({
                    date: dateStr,
                    train: trainNumber,
                    departure: departure,
                    arrival: arrival,
                    seats: seatsAvailable
                  });
                }
              }
            }
          }
        }

        if (!plackartFound) {
          console.log(`    ℹ️  Плацкартов не найдено на эту дату`);
        }

      } catch (error) {
        console.log(`    ❌ Ошибка обработки даты: ${error.message}`);
      }
    }

  } catch (error) {
    console.error('❌ Критическая ошибка:', error.message);
  }
}

async function notifyAboutTickets(ticketInfo) {
  const message = `
🎉 *НАЙДЕНЫ БИЛЕТЫ НА ПЛАЦКАРТ!*

📅 Дата: ${ticketInfo.date}
🚂 Поезд: ${ticketInfo.train}
⏰ Отправление: ${ticketInfo.departure}
🏁 Прибытие: ${ticketInfo.arrival}
💺 Свободных мест: ${ticketInfo.seats}

🔗 Открыть РЖД:
https://pass.rzd.ru/

⚡ *СРОЧНО! Забронируйте билеты прямо сейчас!*
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`    ✅ Уведомление отправлено в Telegram!`);
  } catch (error) {
    console.error(`    ❌ Ошибка Telegram: ${error.message}`);
  }
}

async function startBot() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║  🚂 РЖД БОТ - РЖД API v3         ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры:');
  console.log(`  🚂 Маршрут: Москва (${CONFIG.FROM}) → Симферополь (${CONFIG.TO})`);
  console.log(`  📅 Даты: ${CONFIG.DATES.join(', ')}`);
  console.log(`  💺 Ищем: ПЛАЦКАРТ`);
  console.log(`  ⏰ Проверка: каждые 10 минут`);
  console.log(`  🔌 Используем: pass.rzd.ru JSON API\n`);

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '✅ РЖД-бот запущен! (API v3 - напрямую с РЖД)');
  } catch (error) {
    console.error('⚠️  Ошибка отправки приветствия');
  }

  // Первая проверка сразу
  await searchTickets();

  // По расписанию каждые 10 минут
  console.log('\n✓ Следующая проверка через 10 минут...');
  schedule.scheduleJob(CONFIG.CHECK_INTERVAL, async () => {
    await searchTickets();
  });

  process.on('SIGINT', async () => {
    console.log('\n🛑 Завершаю...');
    process.exit(0);
  });
}

startBot().catch(error => {
  console.error('💥 Ошибка:', error);
  process.exit(1);
});
