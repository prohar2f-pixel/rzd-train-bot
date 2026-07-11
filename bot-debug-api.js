require('dotenv').config();

const axios = require('axios');

const CONFIG = {
  RZD_API: 'https://pass.rzd.ru/timetable/public/ru',
  FROM: '2000000',
  TO: '2078001',
  DATES: ['2026-07-14'],  // Только 14 июля где мы знаем что есть билеты
};

async function makeRequest(params) {
  try {
    const response = await axios.get(CONFIG.RZD_API, {
      params: params,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return response.data;
  } catch (error) {
    console.error(`❌ Ошибка: ${error.message}`);
    return null;
  }
}

async function debugApi() {
  console.log('🔍 ОТЛАДКА РЖД API\n');

  for (const date of CONFIG.DATES) {
    const dateObj = new Date(date);
    const dateStr = dateObj.getDate().toString().padStart(2, '0') + '.' +
                   (dateObj.getMonth() + 1).toString().padStart(2, '0') + '.' +
                   dateObj.getFullYear();

    console.log(`📅 Дата: ${dateStr}\n`);

    // Запрос 1
    console.log('📨 Запрос 1 (создание сессии)...\n');
    const req1Params = {
      'layer_id': 5371,
      'dir': 0,
      'tfl': 3,
      'checkSeats': 1,
      'st0': CONFIG.FROM,
      'st1': CONFIG.TO,
      'dt0': dateStr
    };

    const result1 = await makeRequest(req1Params);

    if (!result1) {
      console.log('⚠️  Пустой ответ на запрос 1');
      continue;
    }

    console.log('✓ Ответ 1 получен\n');
    console.log('📊 СТРУКТУРА ОТВЕТА 1:');
    console.log(JSON.stringify(result1, null, 2));
    console.log('\n' + '='.repeat(80) + '\n');

    const sessionId = result1.result?.sessionID;
    console.log(`🆔 SESSION_ID: ${sessionId}\n`);

    // Ждём
    await new Promise(r => setTimeout(r, 3000));

    // Запрос 2
    console.log('📨 Запрос 2 (получение билетов)...\n');
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

    const result2 = await makeRequest(req2Params);

    if (!result2) {
      console.log('⚠️  Пустой ответ на запрос 2');
      continue;
    }

    console.log('✓ Ответ 2 получен\n');
    console.log('📊 СТРУКТУРА ОТВЕТА 2:');
    console.log(JSON.stringify(result2, null, 2));
    console.log('\n' + '='.repeat(80) + '\n');

    // Анализ поездов
    if (result2.result?.trains) {
      console.log(`\n🚂 НАЙДЕНО ПОЕЗДОВ: ${result2.result.trains.length}\n`);

      result2.result.trains.forEach((train, idx) => {
        console.log(`\n🚆 Поезд ${idx + 1}:`);
        console.log(`  Номер: ${train.number || train.train || 'N/A'}`);
        console.log(`  Отправление: ${train.departure || train.startTime || 'N/A'}`);
        console.log(`  Прибытие: ${train.arrival || train.endTime || 'N/A'}`);
        console.log(`  Ключи в объекте поезда: ${Object.keys(train).join(', ')}`);

        if (train.cars) {
          console.log(`  Вагоны: ${train.cars.length}`);
          train.cars.slice(0, 3).forEach((car, cidx) => {
            console.log(`    Вагон ${cidx + 1}:`, {
              type: car.type,
              typeLoc: car.typeLoc,
              freeSeats: car.freeSeats,
              avail: car.avail,
              price: car.price,
              keys: Object.keys(car).slice(0, 10)
            });
          });
        } else if (train.carriages) {
          console.log(`  Carriages: ${train.carriages.length}`);
        } else {
          console.log(`  ⚠️  Нет информации о вагонах`);
          console.log(`  Все ключи: ${Object.keys(train).join(', ')}`);
        }
      });
    }
  }
}

debugApi().catch(console.error);
