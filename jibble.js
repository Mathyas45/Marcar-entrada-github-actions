const { firefox } = require('playwright');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomJitter = (minMinutes, maxMinutes) => {
    const minMs = minMinutes * 60 * 1000;
    const maxMs = maxMinutes * 60 * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
};

async function run() {
    const email = process.env.JIBBLE_EMAIL;
    const password = process.env.JIBBLE_PASSWORD;
    const actionType = process.env.ACTION_TYPE || 'IN'; 

    // ---- LÓGICA DE FERIADOS ----
    const limaTime = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Lima"}));
    const mm = String(limaTime.getMonth() + 1).padStart(2, '0');
    const dd = String(limaTime.getDate()).padStart(2, '0');
    const todayStr = `${mm}-${dd}`;
    
    // Lista de feriados (Mes-Día)
    const holidays = ['10-08', '12-08', '12-09', '12-25'];
    
    if (holidays.includes(todayStr) && !process.env.TEST_MODE) {
        console.log(`🌴 Hoy es feriado en Perú (${todayStr}). El bot descansará y no marcará asistencia.`);
        process.exit(0);
    }
    // ----------------------------

    if (!email || !password) {
        console.error("❌ Error: Faltan las variables de entorno JIBBLE_EMAIL o JIBBLE_PASSWORD.");
        process.exit(1);
    }

    console.log(`🚀 Iniciando automatización Jibble - Acción: ${actionType}`);

    if (actionType === 'IN') {
        const jitterMs = process.env.TEST_MODE ? 0 : getRandomJitter(1, 4);
        console.log(`⏳ Aplicando retardo aleatorio de ${Math.round(jitterMs / 1000)} segundos...`);
        await delay(jitterMs);
    }

    // Usamos Firefox en modo VISIBLE (headless: false) para burlar la detección de bots.
    // En GitHub Actions usaremos una pantalla virtual (Xvfb) para que no crashee.
    const browser = await firefox.launch({ headless: false }); 
    
    const fs = require('fs');
    let contextOptions = {
        viewport: { width: 1280, height: 720 },
        locale: 'es-PE',
        timezoneId: 'America/Lima',
        permissions: ['geolocation', 'notifications'],
        geolocation: { latitude: -12.046374, longitude: -77.042793 }
    };

    if (fs.existsSync('estado.json')) {
        contextOptions.storageState = 'estado.json';
        console.log("🎟️ Usando Pase VIP (estado.json) para saltar el login...");
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        console.log("🌐 Navegando a Jibble...");
        // Vamos a la página principal y dejamos que Jibble nos redirija al panel correcto
        await page.goto('https://web.jibble.io/', { waitUntil: 'networkidle' });

        if (page.url().includes('/login')) {
            console.log("🔑 Pase VIP no detectado o expirado. Iniciando sesión manualmente...");
            
            const emailSelector = '[data-testid="emailOrPhone"]';
            await page.waitForSelector(emailSelector, { timeout: 15000 });
            await page.click(emailSelector);
            await page.type(emailSelector, email, { delay: 100 });
            
            const pwdSelector = 'input[type="password"]';
            await page.waitForSelector(pwdSelector, { timeout: 10000 });
            await page.click(pwdSelector);
            await page.type(pwdSelector, password, { delay: 100 });
            
            const submitBtnSelector = '[data-testid="login-button"]';
            await page.waitForSelector(submitBtnSelector, { timeout: 5000 });
            
            await page.waitForFunction((selector) => {
                const btn = document.querySelector(selector);
                return btn && !btn.disabled;
            }, submitBtnSelector);
            
            console.log("🖱️ Haciendo clic en Iniciar Sesión...");
            await page.click(submitBtnSelector, { force: true });

            console.log("⏳ Esperando redirección desde Auth0 a la aplicación...");
            await page.waitForURL('**/app/**', { timeout: 30000, waitUntil: 'domcontentloaded' });
        } else {
            console.log("✅ Acceso directo exitoso mediante Pase VIP.");
        }

        console.log("⏳ Esperando a que cargue el dashboard...");
        await page.waitForSelector('.q-header', { timeout: 30000 });
        await delay(4000); 
        console.log("✅ Inicio de sesión exitoso y Dashboard cargado.");

        if (actionType === 'IN') {
            await handleClockIn(page);
        } else if (actionType === 'VERIFY_OR_OUT') {
            await handleVerifyOrOut(page);
        }

    } catch (error) {
        console.error("❌ Ocurrió un error global durante la automatización:", error);
        await page.screenshot({ path: `debug-error-${Date.now()}.png` });
        process.exit(1);
    } finally {
        await browser.close();
        console.log("🛑 Navegador cerrado.");
    }
}

async function handleClockIn(page) {
    console.log("🕒 Iniciando proceso de entrada (Clock In)...");
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`\n--- Intento de Entrada ${attempt}/${MAX_RETRIES} ---`);
            
            // Buscar estrictamente el ÚLTIMO botón en la barra superior (Play/Stop) para ignorar el de Sync
            const actionBtn = page.locator('.q-header .q-btn').last();
            await actionBtn.waitFor({ state: 'visible', timeout: 15000 });
            const btnClass = await actionBtn.evaluate(el => el.className);
            
            if (btnClass.includes('negative') || btnClass.includes('red')) {
                console.log("⚠️ Ya estás Clocked In (Botón rojo de Detener detectado). No se requiere acción.");
                return;
            }

            console.log("▶️ Botón verde detectado. Haciendo clic para marcar entrada...");
            // Forzamos el clic por si algún mensaje de "Bienvenido a Jibble" lo está tapando
            await actionBtn.click({ force: true });

            console.log("⚙️ Esperando formulario de confirmación...");
            await delay(2500); 

            // Función auxiliar para llenar selectores desplegables de Quasar (Jibble)
            async function fillQuasarSelect(testId, exactText) {
                try {
                    const selector = `[data-testid="${testId}"]`;
                    await page.waitForSelector(selector, { timeout: 2000 });
                    
                    // Verificar si ya está seleccionado leyendo el valor del input interno
                    const inputValue = await page.$eval(`${selector} input.q-selectfocus-target`, el => el.value).catch(() => "");
                    if (inputValue && inputValue.includes(exactText)) {
                        console.log(`✅ El campo ${testId} ya tiene seleccionado "${exactText}".`);
                        return;
                    }

                    console.log(`📝 Seleccionando "${exactText}" en el menú...`);
                    await page.click(selector);
                    await delay(1000); // Dar tiempo a que la animación del menú termine
                    
                    // Hacer clic en la opción dentro del menú (.q-menu)
                    await page.locator('.q-menu').getByText(exactText, { exact: false }).first().click();
                    await delay(500);
                } catch (e) {
                    console.log(`⚠️ Advertencia: No se pudo seleccionar "${exactText}" (Tal vez ya estaba puesto). Omitiendo...`);
                }
            }

            // Seleccionar los campos obligatorios para UTP (solo en la entrada)
            await fillQuasarSelect('select-activity', 'Cumplimiento de horario');
            await fillQuasarSelect('select-project', 'Marcación de horario - UTP');

            // Ajustar la salida automática para que no sea exactamente 10 horas después, sino alrededor de las 6:30 PM
            try {
                console.log("📝 Ajustando hora de salida automática (Auto Clock Out)...");
                const autoClockOutBtn = page.locator('[data-testid="auto-clock-out-chip"]');
                if (await autoClockOutBtn.isVisible()) {
                    await autoClockOutBtn.click();
                    await delay(1000);
                    
                    // Asegurar que el switch de salida automática esté encendido
                    const switchBtn = page.locator('[data-testid="on-off-switch"]');
                    const isChecked = await switchBtn.getAttribute('aria-checked');
                    if (isChecked === 'false') {
                        await switchBtn.click();
                        await delay(500);
                    }

                    // Abrir el selector de tiempo
                    await page.click('[data-testid="reminder-time-picker"] input.vue__time-picker-input');
                    await delay(500);

                    // Seleccionar 6
                    await page.click('[data-testid="reminder-time-picker"] ul.hours li[data-key="6"]');
                    await delay(300);

                    // Seleccionar un minuto aleatorio entre 30 y 35 (para que parezca humano)
                    const randomMin = Math.floor(Math.random() * (35 - 30 + 1) + 30).toString();
                    await page.click(`[data-testid="reminder-time-picker"] ul.minutes li[data-key="${randomMin}"]`);
                    await delay(300);

                    // Seleccionar PM
                    await page.click('[data-testid="reminder-time-picker"] ul.apms li[data-key="pm"]');
                    await delay(500);
                    
                    // Cerrar el modal presionando Escape
                    await page.keyboard.press('Escape');
                    await delay(500);
                    
                    console.log(`✅ Salida automática fijada aleatoriamente a las 6:${randomMin} PM.`);
                }
            } catch (e) {
                console.log("⚠️ No se pudo ajustar la salida automática, omitiendo...");
            }

            const confirmBtn = await page.waitForSelector('button:has-text("Save"), button:has-text("Confirm"), button:has-text("Guardar"), button:has-text("Confirmar")', { timeout: 5000 });
            console.log("💾 Presionando botón Guardar...");
            await confirmBtn.click();
            
            await delay(3000);

            const errorVisible = await page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return text.includes('time mismatch') || text.includes('invalid time');
            });
            
            const isModalStillOpen = await confirmBtn.isVisible().catch(() => false);

            if (errorVisible || isModalStillOpen) {
                throw new Error("Desfase de hora detectado ('time mismatch' / 'invalid time') o el modal no se cerró.");
            }

            console.log("✅ Entrada marcada exitosamente.");
            return; 

        } catch (error) {
            console.log(`❌ Error en el intento ${attempt}: ${error.message}`);
            if (attempt < MAX_RETRIES) {
                console.log("🔄 Recargando la página y reintentando en 3 segundos...");
                await page.reload({ waitUntil: 'networkidle' });
                await delay(3000);
            } else {
                throw new Error("Se agotaron los 3 reintentos para Clock In.");
            }
        }
    }
}

async function handleVerifyOrOut(page) {
    console.log("🕒 Iniciando proceso de salida (Clock Out)...");
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`\n--- Intento de Salida ${attempt}/${MAX_RETRIES} ---`);
            
            // Buscar estrictamente el ÚLTIMO botón en la barra superior (Play/Stop) para ignorar el de Sync
            const actionBtn = page.locator('.q-header .q-btn').last();
            await actionBtn.waitFor({ state: 'visible', timeout: 15000 });
            const btnClass = await actionBtn.evaluate(el => el.className);
            
            if (btnClass.includes('positive') || btnClass.includes('green')) {
                console.log("✅ El usuario ya está desconectado (Botón verde detectado). Finalizando con éxito...");
                return;
            }

            console.log("⏹️ Botón rojo detectado. Forzando Clock Out...");
            // Forzamos el clic por si algún mensaje de "Bienvenido a Jibble" lo está tapando
            await actionBtn.click({ force: true });

            console.log("⚙️ Esperando formulario de confirmación...");
            await delay(2500);

            const confirmBtn = await page.waitForSelector('button:has-text("Save"), button:has-text("Confirm"), button:has-text("Guardar"), button:has-text("Confirmar")', { timeout: 5000 });
            console.log("💾 Presionando botón Guardar...");
            await confirmBtn.click();
            
            await delay(3000);

            const errorVisible = await page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return text.includes('time mismatch') || text.includes('invalid time');
            });
            
            const isModalStillOpen = await confirmBtn.isVisible().catch(() => false);

            if (errorVisible || isModalStillOpen) {
                throw new Error("Desfase de hora detectado ('time mismatch' / 'invalid time') o el modal no se cerró.");
            }

            console.log("✅ Salida (Clock Out) registrada correctamente.");
            return;
            
        } catch (error) {
            console.log(`❌ Error en el intento ${attempt}: ${error.message}`);
            if (attempt < MAX_RETRIES) {
                console.log("🔄 Recargando la página y reintentando en 3 segundos...");
                await page.reload({ waitUntil: 'networkidle' });
                await delay(3000);
            } else {
                throw new Error("Se agotaron los 3 reintentos para Clock Out.");
            }
        }
    }
}

run();
