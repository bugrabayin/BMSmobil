// ==========================================
// BMSmobil CORE LOGIC & WEB BLUETOOTH DECODER
// ==========================================

// Register Service Worker for offline PWA installation
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
            .then(reg => console.log('Service Worker registered successfully.', reg.scope))
            .catch(err => console.warn('Service Worker registration failed: ', err));
    });
}

// Global state variables
let currentTab = 'simulation';
let connectionState = 'simulation'; // "simulation", "disconnected", "connecting", "connected_webble", "connected_gateway"
let telemetryData = null;

// Remote Gateway details
let gatewaySocket = null;

// Web Bluetooth contexts
let webBleDevice = null;
let webBleCharacteristic = null;
let webBleNotifyCharacteristic = null;
let bleReceiveBuffer = new Uint8Array(0);
let webBlePollInterval = null;

// Pending switch control variables (for safety modal)
let pendingSwitchType = null;
let pendingSwitchState = null;
let pendingSwitchCheckbox = null;

// Simulation loop interval
let simulationInterval = null;

// Chart.js context
let liveChart;
let currentChartType = 'general'; // 'general', 'cells', 'power'
let chartDataPoints = {
    labels: [],
    voltage: [],
    current: [],
    power: [],
    cells: [] // Array of arrays: cells[i] stores history for Cell i+1
};

// JKBMS register length dictionary for Javascript decoder
const REGISTER_LENGTHS = {
    0x79: -1, // Variable length cells
    0x80: 2,  // Temp Sensor 1 (signed short)
    0x81: 2,  // Temp Sensor 2 (signed short)
    0x82: 2,  // MOS Temp (signed short)
    0x83: 2,  // Total Voltage (unsigned short, 0.01V)
    0x84: 2,  // Current (unsigned short, offset 32768, 0.01A)
    0x85: 1,  // SoC (unsigned byte)
    0x86: 1,  // Temp sensor count
    0x87: 2,  // Cycle count
    0x89: 4,  // Nominal capacity (Ah)
    0x8A: 1,  // Cell count setting
    0x8B: 2,  // Alarm flags (2 bytes)
    0x8C: 1,  // Status/balancing flags
    0x8E: 2,  // Over-voltage protection (V)
    0x8F: 2,  // Under-voltage protection (V)
    0x90: 1,  // Charging Switch (1 byte, 1=ON, 0=OFF)
    0x91: 1,  // Discharging Switch (1 byte, 1=ON, 0=OFF)
    0x92: 2,  // Balancing Current (A)
    0x93: 1,  // Balancing Switch (1 byte, 1=ON, 0=OFF)
    0x94: 2,  // Balance Trigger Voltage (V)
    0x95: 2,  // Power Off Voltage (V)
    0xAA: 4,  // Remaining Capacity (Ah)
    0xBA: 24, // Model Name (string)
    0xC0: 1,  // Protocol version
};

// ==========================================
// STARTUP INITIALIZATION
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    initChart();
    
    // Log application version
    appendLogConsole("JKBMS Pro Mobil v14 başlatıldı.", "INFO");
    
    // Auto start in Simulation Mode
    activateSimulation();
    
    // Check if hosted via gateway server, if so fill IP input automatically
    if (window.location.host && !window.location.host.startsWith("file")) {
        document.getElementById("gateway-ip").value = window.location.hostname;
    }
});

function toggleSidebar(show) {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (show) {
        sidebar.classList.add("active");
        overlay.classList.add("active");
    } else {
        sidebar.classList.remove("active");
        overlay.classList.remove("active");
    }
}

async function writeWebBleCharacteristic(value) {
    if (!webBleCharacteristic) return;
    try {
        if (webBleCharacteristic.writeValueWithoutResponse) {
            await webBleCharacteristic.writeValueWithoutResponse(value);
        } else {
            await webBleCharacteristic.writeValue(value);
        }
    } catch (e) {
        console.warn("BLE writeValueWithoutResponse failed, falling back to writeValue:", e);
        await webBleCharacteristic.writeValue(value);
    }
}

// ==========================================
// DIRECT WEB BLUETOOTH CONNECTION (CLIENT SIDE)
// ==========================================
async function connectWebBluetooth() {
    appendLogConsole("Web Bluetooth taraması başlatılıyor...", "INFO");
    toggleSidebar(false); // Close sidebar on mobile to show scanning
    
    try {
        // Request bluetooth device filtering for JKBMS
        // Standard JKBMS BLE advertiser names usually start with JK- or BMS
        webBleDevice = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [0xffe0] // FFE0 is the typical JKBMS service UUID
        });
        
        appendLogConsole(`Cihaz seçildi: ${webBleDevice.name}. Bağlanılıyor...`, "INFO");
        connectionState = 'connecting';
        updateConnectionUI();
        
        // Connect to GATT
        const server = await webBleDevice.gatt.connect();
        appendLogConsole("GATT sunucusuna bağlanıldı. Servis alınıyor...", "INFO");
        
        const service = await server.getPrimaryService(0xffe0);
        appendLogConsole("Servis alındı. Özellikler taranıyor...", "INFO");
        
        const characteristics = await service.getCharacteristics();
        appendLogConsole(`Bulunan BLE özellik sayısı: ${characteristics.length}`, "INFO");
        
        let writeChar = null;
        let notifyChar = null;
        
        characteristics.forEach((char, index) => {
            const uuid = char.uuid.toLowerCase();
            const props = [];
            if (char.properties.read) props.push("read");
            if (char.properties.write) props.push("write");
            if (char.properties.writeWithoutResponse) props.push("writeWithoutResponse");
            if (char.properties.notify) props.push("notify");
            if (char.properties.indicate) props.push("indicate");
            
            appendLogConsole(`Özellik #${index}: ${uuid.substring(4, 8).toUpperCase()} [${props.join(", ")}]`, "INFO");
            
            if (uuid.includes("ffe1")) {
                if (char.properties.notify) notifyChar = char;
                if (char.properties.write || char.properties.writeWithoutResponse) writeChar = char;
            }
        });
        
        // Fallback: If we didn't find FFE1 with notify/write, use any matching characteristics
        if (!notifyChar || !writeChar) {
            characteristics.forEach(char => {
                if (!notifyChar && char.properties.notify) notifyChar = char;
                if (!writeChar && (char.properties.write || char.properties.writeWithoutResponse)) writeChar = char;
            });
        }
        
        if (!notifyChar || !writeChar) {
            throw new Error("Gerekli okuma/yazma BLE özellikleri bulunamadı.");
        }
        
        webBleCharacteristic = writeChar;
        webBleNotifyCharacteristic = notifyChar;
        
        // Register event listener BEFORE starting notifications to prevent race conditions
        webBleNotifyCharacteristic.addEventListener('characteristicvaluechanged', handleWebBleNotification);
        await webBleNotifyCharacteristic.startNotifications();
        
        appendLogConsole("Bluetooth bildirimleri dinleniyor...", "INFO");
        connectionState = 'connected_webble';
        updateConnectionUI();
        
        // Stop mock engine if running
        stopSimulation();
        
        // Send initial status query commands
        appendLogConsole("BLE el sıkışması başlatılıyor (0x97)...", "INFO");
        const cmd_97 = buildBleCommand(0x97, 0);
        await writeWebBleCharacteristic(cmd_97);
        
        // Wait 350ms, then send 0x96 Cell Info command
        setTimeout(async () => {
            if (webBleDevice && webBleDevice.gatt && webBleDevice.gatt.connected) {
                try {
                    appendLogConsole("BLE hücre verisi sorgulanıyor (0x96)...", "INFO");
                    const cmd_96 = buildBleCommand(0x96, 1);
                    await writeWebBleCharacteristic(cmd_96);
                } catch (e) {
                    appendLogConsole("Hata: 0x96 gönderilemedi: " + e.message, "ERROR");
                }
            }
        }, 350);
        
        // Setup polling interval every 4 seconds to keep-alive and query cell status
        let bleCounter = 2;
        if (webBlePollInterval) clearInterval(webBlePollInterval);
        webBlePollInterval = setInterval(async () => {
            if (webBleDevice && webBleDevice.gatt && webBleDevice.gatt.connected) {
                try {
                    const cmd_96 = buildBleCommand(0x96, bleCounter++);
                    await writeWebBleCharacteristic(cmd_96);
                } catch (e) {
                    appendLogConsole("Sorgu gönderme hatası: " + e.message, "ERROR");
                }
            }
        }, 4000);
        
        // Listen for disconnect event
        webBleDevice.addEventListener('gattserverdisconnected', onWebBleDisconnected);
        
        document.getElementById("webble-status-box").classList.remove("hidden");
        document.getElementById("webble-conn-status").textContent = "Bağlı";
        document.getElementById("webble-conn-name").textContent = webBleDevice.name;
        
    } catch (error) {
        appendLogConsole(`Web Bluetooth Bağlantı Hatası: ${error}`, "ERROR");
        connectionState = 'disconnected';
        updateConnectionUI();
        alert(`Bluetooth bağlantı hatası: ${error.message || error}`);
    }
}

function onWebBleDisconnected() {
    appendLogConsole("Bluetooth bağlantısı koptu.", "WARNING");
    if (webBlePollInterval) clearInterval(webBlePollInterval);
    document.getElementById("webble-status-box").classList.add("hidden");
    connectionState = 'disconnected';
    updateConnectionUI();
}

// ==========================================
// CLIENT-SIDE JKBMS BINARY DECODER (JS)
// ==========================================
let lastDataLogTime = 0;
function handleWebBleNotification(event) {
    const value = event.target.value; // DataView containing BLE chunk
    // FIX: Extract only the active slice of the shared ArrayBuffer
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    
    // Log a brief message to the console every 4 seconds to confirm data is arriving
    const now = Date.now();
    if (now - lastDataLogTime > 4000) {
        appendLogConsole(`Veri akışı: JKBMS'ten ${chunk.length} bayt sinyal alındı.`, "INFO");
        lastDataLogTime = now;
    }
    
    // Append new chunk to bleReceiveBuffer
    const newBuffer = new Uint8Array(bleReceiveBuffer.length + chunk.length);
    newBuffer.set(bleReceiveBuffer);
    newBuffer.set(chunk, bleReceiveBuffer.length);
    bleReceiveBuffer = newBuffer;
    
    // Assemble complete JKBMS frames
    let frames = assembleJSFrames();
    for (let frame of frames) {
        try {
            let telemetry = null;
            if (frame.isBle) {
                telemetry = decodeBleFrame(frame);
            } else {
                telemetry = decodeJSFrame(frame);
            }
            if (telemetry) {
                telemetry.timestamp = Date.now() / 1000;
                handleTelemetryUpdate(telemetry);
            }
        } catch (e) {
            console.error("Error decoding Frame:", e);
        }
    }
}

function assembleJSFrames() {
    let frames = [];
    
    while (true) {
        if (bleReceiveBuffer.length === 0) break;
        
        // Find header signature: either 4E 57 (UART) or 55 AA EB 90 (BLE)
        let startIdx = -1;
        let isBleFrame = false;
        
        for (let i = 0; i < bleReceiveBuffer.length - 1; i++) {
            // Check UART signature
            if (bleReceiveBuffer[i] === 0x4e && bleReceiveBuffer[i+1] === 0x57) {
                startIdx = i;
                isBleFrame = false;
                break;
            }
            // Check BLE signature
            if (i < bleReceiveBuffer.length - 3 && 
                bleReceiveBuffer[i] === 0x55 && 
                bleReceiveBuffer[i+1] === 0xAA && 
                bleReceiveBuffer[i+2] === 0xEB && 
                bleReceiveBuffer[i+3] === 0x90) {
                startIdx = i;
                isBleFrame = true;
                break;
            }
        }
        
        if (startIdx === -1) {
            // No signature found, check if last bytes could be start of signature
            let foundPartial = false;
            for (let i = Math.max(0, bleReceiveBuffer.length - 3); i < bleReceiveBuffer.length; i++) {
                if (bleReceiveBuffer[i] === 0x4e || bleReceiveBuffer[i] === 0x55) {
                    bleReceiveBuffer = bleReceiveBuffer.slice(i);
                    foundPartial = true;
                    break;
                }
            }
            if (!foundPartial) {
                bleReceiveBuffer = new Uint8Array(0);
            }
            break;
        }
        
        // Slice away junk preceding the start index
        if (startIdx > 0) {
            bleReceiveBuffer = bleReceiveBuffer.slice(startIdx);
        }
        
        if (isBleFrame) {
            // BLE frame is fixed 300 bytes
            const totalFrameLen = 300;
            if (bleReceiveBuffer.length < totalFrameLen) {
                // Incomplete BLE frame, wait for more chunks
                break;
            }
            // Extract complete frame
            const frame = bleReceiveBuffer.slice(0, totalFrameLen);
            bleReceiveBuffer = bleReceiveBuffer.slice(totalFrameLen);
            
            // Verify BLE Checksum (sum of bytes 0-298)
            let sum = 0;
            for (let i = 0; i < 299; i++) {
                sum += frame[i];
            }
            const computedCrc = sum & 0xFF;
            const remoteCrc = frame[299];
            
            if (computedCrc === remoteCrc) {
                frame.isBle = true;
                frames.push(frame);
            } else {
                console.warn(`BLE Checksum invalid: computed 0x${computedCrc.toString(16)} != remote 0x${remoteCrc.toString(16)}`);
                // Discard invalid header bytes to continue searching
                bleReceiveBuffer = bleReceiveBuffer.slice(4);
            }
        } else {
            // UART frame (variable length)
            if (bleReceiveBuffer.length < 4) {
                break;
            }
            // Payload len is at bytes 2,3 (big endian)
            const payloadLen = (bleReceiveBuffer[2] << 8) | bleReceiveBuffer[3];
            const totalFrameLen = payloadLen + 4;
            
            if (bleReceiveBuffer.length < totalFrameLen) {
                break;
            }
            const frame = bleReceiveBuffer.slice(0, totalFrameLen);
            bleReceiveBuffer = bleReceiveBuffer.slice(totalFrameLen);
            
            if (verifyJSChecksum(frame)) {
                frame.isBle = false;
                frames.push(frame);
            } else {
                console.warn("UART Checksum invalid, discarding frame.");
                bleReceiveBuffer = bleReceiveBuffer.slice(2);
            }
        }
    }
    
    return frames;
}

function verifyJSChecksum(frame) {
    if (frame.length < 10) return false;
    const len = frame.length;
    const expected = ((frame[len-4] << 24) | (frame[len-3] << 16) | (frame[len-2] << 8) | frame[len-1]) >>> 0;
    
    let sum = 0;
    for (let i = 0; i < len - 4; i++) {
        sum += frame[i];
    }
    const calculated = sum & 0xFFFFFFFF;
    return expected === calculated;
}

function getUint16LE(buf, offset) {
    return (buf[offset + 1] << 8) | buf[offset];
}

function getInt16LE(buf, offset) {
    const val = (buf[offset + 1] << 8) | buf[offset];
    return (val & 0x8000) ? (val - 0x10000) : val;
}

function getUint32LE(buf, offset) {
    return ((buf[offset + 3] << 24) | (buf[offset + 2] << 16) | (buf[offset + 1] << 8) | buf[offset]) >>> 0;
}

function getInt32LE(buf, offset) {
    const val = (buf[offset + 3] << 24) | (buf[offset + 2] << 16) | (buf[offset + 1] << 8) | buf[offset];
    return val;
}

function buildBleCommand(cmdByte, counter) {
    const frame = new Uint8Array(20);
    frame[0] = 0xAA;
    frame[1] = 0x55;
    frame[2] = 0x90;
    frame[3] = 0xEB;
    frame[4] = cmdByte;
    frame[5] = 0x00;
    // 6 to 15 remain 0x00
    frame[16] = counter & 0xFF;
    // 17 to 18 remain 0x00
    
    let sum = 0;
    for (let i = 0; i < 19; i++) {
        sum += frame[i];
    }
    frame[19] = sum & 0xFF;
    return frame;
}

function decodeBleFrame(frame) {
    const frame_type = frame[4];
    if (frame_type !== 0x02) {
        return null;
    }
    
    // Auto-detect layout: check total voltage at 118 (24S) vs 150 (32S)
    let total_voltage_24s = getUint32LE(frame, 118) * 0.001;
    let offset = 0;
    let is32S = false;
    
    if (total_voltage_24s > 150.0 || total_voltage_24s < 1.0) {
        offset = 32;
        is32S = true;
    }
    
    let cell_voltages = [];
    const maxCells = is32S ? 32 : 24;
    for (let i = 0; i < maxCells; i++) {
        let volt_mv = getUint16LE(frame, i * 2 + 6);
        let volt = volt_mv * 0.001;
        if (volt > 0.5 && volt < 5.0) {
            cell_voltages.push(volt);
        }
    }
    
    let total_voltage = getUint32LE(frame, 118 + offset) * 0.001;
    let current = getInt32LE(frame, 126 + offset) * 0.001;
    let temp1 = getInt16LE(frame, 130 + offset) * 0.1;
    let temp2 = getInt16LE(frame, 132 + offset) * 0.1;
    
    let mos_temp;
    let error_bitmask;
    if (is32S) {
        // In 32S, MOS temperature is at 112 + 32 = 144
        mos_temp = getInt16LE(frame, 144) * 0.1;
        // In 32S, errors is a 32-bit field at 134 + 32 = 166
        error_bitmask = getUint32LE(frame, 166);
    } else {
        // In 24S, MOS temperature is at 134
        mos_temp = getInt16LE(frame, 134) * 0.1;
        // In 24S, errors is a 16-bit field at 136
        error_bitmask = getUint16LE(frame, 136);
    }
    
    let balancing_current = getInt16LE(frame, 138 + offset) * 0.001;
    let balancing_active = (frame[140 + offset] !== 0x00);
    let soc = frame[141 + offset];
    let capacity_remaining = getUint32LE(frame, 142 + offset) * 0.001;
    let full_charge_capacity = getUint32LE(frame, 146 + offset) * 0.001;
    let cycle_count = getUint32LE(frame, 150 + offset);
    
    let charging_switch = (frame[166 + offset] === 0x01);
    let discharging_switch = (frame[167 + offset] === 0x01);
    let balancing_switch = (frame[169 + offset] === 0x01);
    
    let alerts = parseJSAlarms(error_bitmask);
    
    return {
        bms_id: is32S ? "JK_BLE_32S" : "JK_BLE_24S",
        cmd_type: 0x02,
        cell_voltages: cell_voltages,
        cell_count: cell_voltages.length,
        total_voltage: total_voltage,
        current: current,
        temperatures: {
            probe_1: temp1,
            probe_2: temp2,
            mos: mos_temp
        },
        balancing_current: balancing_current,
        balancing_active: balancing_active,
        soc: soc,
        capacity_remaining: capacity_remaining,
        capacity_nominal: full_charge_capacity,
        cycle_count: cycle_count,
        charging_switch: charging_switch,
        discharging_switch: discharging_switch,
        balancing_switch: balancing_switch,
        alerts: alerts
    };
}

function decodeJSFrame(frame) {
    if (frame.length < 14) return null;
    
    const bms_id = Array.from(frame.slice(4, 8))
        .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const cmd_type = frame[8];
    
    // Payload starts at byte 11 and ends before end-byte (0x68) and checksum
    const payload = frame.slice(11, frame.length - 5);
    
    let result = {
        bms_id: bms_id,
        cmd_type: cmd_type,
        cell_voltages: [],
        temperatures: {},
        alerts: []
    };
    
    let idx = 0;
    while (idx < payload.length) {
        let code = payload[idx];
        idx += 1;
        
        let reg_len = REGISTER_LENGTHS[code] || 0;
        let reg_data;
        
        if (code === 0x79) {
            // Variable length cell voltages
            let len = payload[idx];
            idx += 1;
            reg_data = payload.slice(idx, idx + len);
            idx += len;
            
            let cells = [];
            for (let c = 0; c < reg_data.length; c += 3) {
                if (c + 3 <= reg_data.length) {
                    let cell_id = reg_data[c];
                    let volt_mv = (reg_data[c+1] << 8) | reg_data[c+2];
                    cells.push({ id: cell_id, volt: volt_mv / 1000.0 });
                }
            }
            cells.sort((a,b) => a.id - b.id);
            result.cell_voltages = cells.map(c => c.volt);
            result.cell_count = cells.length;
            
        } else if (reg_len > 0) {
            reg_data = payload.slice(idx, idx + reg_len);
            idx += reg_len;
            
            if (code === 0x80) {
                result.temperatures.probe_1 = getSignedShortJS(reg_data);
            } else if (code === 0x81) {
                result.temperatures.probe_2 = getSignedShortJS(reg_data);
            } else if (code === 0x82) {
                result.temperatures.mos = getSignedShortJS(reg_data);
            } else if (code === 0x83) {
                result.total_voltage = ((reg_data[0] << 8) | reg_data[1]) * 0.01;
            } else if (code === 0x84) {
                // Current value offset 32768
                let val = (reg_data[0] << 8) | reg_data[1];
                result.current = (val - 32768) * 0.01;
            } else if (code === 0x85) {
                result.soc = reg_data[0];
            } else if (code === 0x87) {
                result.cycle_count = (reg_data[0] << 8) | reg_data[1];
            } else if (code === 0x89) {
                let val = (reg_data[0] << 24) | (reg_data[1] << 16) | (reg_data[2] << 8) | reg_data[3];
                result.capacity_nominal = val * 0.001; // scale from Ah/mAh
            } else if (code === 0x8B) {
                let alarm_word = (reg_data[0] << 8) | reg_data[1];
                result.alarm_flags = alarm_word;
                result.alerts = parseJSAlarms(alarm_word);
            } else if (code === 0x8C) {
                result.balancing_active = (reg_data[0] === 1);
            } else if (code === 0x90) {
                result.charging_switch = (reg_data[0] === 1);
            } else if (code === 0x91) {
                result.discharging_switch = (reg_data[0] === 1);
            } else if (code === 0x92) {
                result.balancing_current = ((reg_data[0] << 8) | reg_data[1]) * 0.001;
            } else if (code === 0x93) {
                result.balancing_switch = (reg_data[0] === 1);
            } else if (code === 0xAA) {
                let val = (reg_data[0] << 24) | (reg_data[1] << 16) | (reg_data[2] << 8) | reg_data[3];
                result.capacity_remaining = val * 0.001;
            } else if (code === 0xBA) {
                result.model_name = new TextDecoder().decode(reg_data).trim();
            }
        } else {
            // Unknown code, abort frame parse to prevent desync
            break;
        }
    }
    
    // Derive stats
    if (result.cell_voltages && result.cell_voltages.length > 0) {
        const cvs = result.cell_voltages;
        result.max_cell_voltage = Math.max(...cvs);
        result.min_cell_voltage = Math.min(...cvs);
        result.max_cell_index = cvs.indexOf(result.max_cell_voltage) + 1;
        result.min_cell_index = cvs.indexOf(result.min_cell_voltage) + 1;
        result.cell_delta = result.max_cell_voltage - result.min_cell_voltage;
        result.average_cell_voltage = cvs.reduce((a,b)=>a+b,0) / cvs.length;
    }
    
    if (result.total_voltage !== undefined && result.current !== undefined) {
        result.power = result.total_voltage * result.current;
    }
    
    return result;
}

function getSignedShortJS(bytes) {
    let val = (bytes[0] << 8) | bytes[1];
    if (val & 0x8000) {
        val = val - 0x10000;
    }
    return val;
}

function parseJSAlarms(alarm_word) {
    const alarms = [];
    const bit_meanings = {
        0: "Hücre Aşırı Gerilim Koruması (OVP)",
        1: "Hücre Düşük Gerilim Koruması (UVP)",
        2: "Batarya Aşırı Gerilim Koruması (Pack OVP)",
        3: "Batarya Düşük Gerilim Koruması (Pack UVP)",
        4: "Şarj Aşırı Sıcaklık Koruması",
        5: "Şarj Düşük Sıcaklık Koruması",
        6: "Deşarj Aşırı Sıcaklık Koruması",
        7: "Deşarj Düşük Sıcaklık Koruması",
        8: "MOSFET Aşırı Sıcaklık Koruması",
        9: "Şarj Aşırı Akım Koruması (OCP)",
        10: "Deşarj Aşırı Akım Koruması (OCP)",
        11: "Kısa Devre Koruması",
        12: "Hücre Dengeleme Sıcaklık Uyarısı",
        13: "Hücre Gerilim Farkı Aşırı Yüksek (İmbalans)",
        14: "Kablo Bağlantı Hatası (Cell Wire Loose)",
        15: "Sıcaklık Sensörü Hatası"
    };
    for (let bit in bit_meanings) {
        if (alarm_word & (1 << bit)) {
            alarms.push(bit_meanings[bit]);
        }
    }
    return alarms;
}

function buildJSCommandFrame(cmd_register, state_byte) {
    // Construct command payload frame
    const header = [0x4e, 0x57];
    const length_placeholder = [0x00, 0x00];
    const bms_id = [0x00, 0x00, 0x00, 0x00];
    const cmd = cmd_register; // 0x90, 0x91, 0x93
    const src = 0x02; // BLE app source
    const frame_type = 0x01; // write
    const payload = [state_byte]; // 0x01 or 0x00
    const end_byte = 0x68;
    
    // Combine structure
    const body = bms_id.concat([cmd, src, frame_type]).concat(payload).concat([end_byte]);
    // Payload length field represents size of body + checksum
    const total_body_len = body.length + 4; // body + 4 byte checksum
    
    const frame = new Uint8Array(header.length + 2 + body.length + 4);
    frame.set(header);
    frame[2] = (total_body_len >> 8) & 0xff;
    frame[3] = total_body_len & 0xff;
    frame.set(body, 4);
    
    // Compute checksum
    let sum = 0;
    for (let i = 0; i < frame.length - 4; i++) {
        sum += frame[i];
    }
    const checksum = sum & 0xFFFFFFFF;
    
    frame[frame.length - 4] = (checksum >> 24) & 0xff;
    frame[frame.length - 3] = (checksum >> 16) & 0xff;
    frame[frame.length - 2] = (checksum >> 8) & 0xff;
    frame[frame.length - 1] = checksum & 0xff;
    
    return frame;
}

// ==========================================
// REMOTE GATEWAY SERVER CONNECTION (WIFI WEBSOCKET)
// ==========================================
function connectToGatewayServer() {
    const ip = document.getElementById("gateway-ip").value;
    if (!ip) {
        alert("Lütfen sunucu IP adresini girin.");
        return;
    }
    
    if (gatewaySocket) {
        gatewaySocket.close();
    }
    
    appendLogConsole(`Ağ Geçidi sunucusuna bağlanılıyor: ws://${ip}:8000/ws`, "INFO");
    connectionState = 'connecting';
    updateConnectionUI();
    toggleSidebar(false);
    
    gatewaySocket = new WebSocket(`ws://${ip}:8000/ws`);
    
    gatewaySocket.onopen = () => {
        appendLogConsole("Ağ Geçidi sunucusuna başarıyla bağlanıldı.", "INFO");
        connectionState = 'connected_gateway';
        updateConnectionUI();
        stopSimulation();
    };
    
    gatewaySocket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "init" || msg.type === "telemetry") {
            handleTelemetryUpdate(msg.data.telemetry || msg.data);
        } else if (msg.type === "log") {
            appendLogConsole(msg.data.message, msg.data.level, msg.data.timestamp);
        }
    };
    
    gatewaySocket.onclose = () => {
        appendLogConsole("Ağ Geçidi sunucusu bağlantısı kapandı.", "WARNING");
        if (connectionState === 'connected_gateway') {
            connectionState = 'disconnected';
            updateConnectionUI();
        }
    };
    
    gatewaySocket.onerror = (err) => {
        appendLogConsole("Ağ Geçidi bağlantı hatası oluştu.", "ERROR");
    };
}

// ==========================================
// TELEMETRY VIEW UPDATES & SWITCHES
// ==========================================
function handleTelemetryUpdate(data) {
    telemetryData = data;
    
    // 1. Update headers
    document.getElementById("bms-model").textContent = data.model_name || "JKBMS BLE";
    document.getElementById("bms-meta").textContent = `Cihaz ID: ${data.bms_id || '--'} | Hücre Sayısı: ${data.cell_count}S`;
    
    // 2. SoC display
    document.getElementById("soc-value").textContent = Number(data.soc).toFixed(2);
    document.getElementById("soc-capacity").textContent = `${data.capacity_remaining.toFixed(1)} / ${data.capacity_nominal.toFixed(0)} Ah`;
    
    const circle = document.getElementById("soc-circle");
    const radius = circle.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (data.soc / 100) * circumference;
    circle.style.strokeDashoffset = offset;
    
    if (data.soc < 20) circle.style.stroke = "var(--color-danger)";
    else if (data.soc < 50) circle.style.stroke = "var(--color-warning)";
    else circle.style.stroke = "var(--color-primary)";
    
    const socSub = document.getElementById("soc-subtext");
    if (data.current > 0.1) {
        socSub.innerHTML = `Akış: <span style="color:var(--color-charging)">Şarj Oluyor (+${data.current.toFixed(1)} A)</span>`;
    } else if (data.current < -0.1) {
        socSub.innerHTML = `Akış: <span style="color:var(--color-discharging)">Deşarj Oluyor (${data.current.toFixed(1)} A)</span>`;
    } else {
        socSub.innerHTML = `Akış: <span style="color:var(--color-text-muted)">Beklemede (Standby)</span>`;
    }
    
    // 3. Power Metrics
    document.getElementById("metric-voltage").textContent = `${data.total_voltage.toFixed(2)} V`;
    
    const currentEl = document.getElementById("metric-current");
    currentEl.textContent = `${data.current.toFixed(2)} A`;
    currentEl.style.color = data.current > 0.1 ? "var(--color-charging)" : (data.current < -0.1 ? "var(--color-discharging)" : "var(--color-text-muted)");
    
    const powerEl = document.getElementById("metric-power");
    powerEl.textContent = `${data.power.toFixed(0)} W`;
    powerEl.style.color = data.power > 1 ? "var(--color-charging)" : (data.power < -1 ? "var(--color-discharging)" : "var(--color-text)");
    
    document.getElementById("metric-cycles").textContent = data.cycle_count || 0;
    
    // 4. Cell stats
    document.getElementById("stat-avg-cell").textContent = `${data.average_cell_voltage.toFixed(3)} V`;
    document.getElementById("stat-max-cell").textContent = `${data.max_cell_voltage.toFixed(3)} V (#${data.max_cell_index})`;
    document.getElementById("stat-min-cell").textContent = `${data.min_cell_voltage.toFixed(3)} V (#${data.min_cell_index})`;
    
    const deltaMv = (data.cell_delta * 1000).toFixed(0);
    const deltaEl = document.getElementById("stat-delta-cell");
    deltaEl.textContent = `${deltaMv} mV`;
    deltaEl.style.color = deltaMv > 100 ? "var(--color-danger)" : (deltaMv > 40 ? "var(--color-warning)" : "var(--color-balancing)");
    
    // 5. Temperatures
    document.getElementById("temp-p1").textContent = `${data.temperatures.probe_1.toFixed(1)} °C`;
    document.getElementById("temp-p2").textContent = `${data.temperatures.probe_2.toFixed(1)} °C`;
    document.getElementById("temp-mos").textContent = `${data.temperatures.mos.toFixed(1)} °C`;
    
    updateTempProgressBar("temp-p1-bar", data.temperatures.probe_1, 60);
    updateTempProgressBar("temp-p2-bar", data.temperatures.probe_2, 60);
    updateTempProgressBar("temp-mos-bar", data.temperatures.mos, 85);
    
    // 6. Alarms
    const alarmBanner = document.getElementById("alarm-banner");
    const alarmText = document.getElementById("alarm-list-text");
    if (data.alerts && data.alerts.length > 0) {
        alarmBanner.classList.remove("hidden");
        alarmText.textContent = data.alerts.join(", ");
    } else {
        alarmBanner.classList.add("hidden");
    }
    
    // 7. Sync switches
    setCheckboxWithoutEvent("switch-charge", data.charging_switch);
    setCheckboxWithoutEvent("switch-discharge", data.discharging_switch);
    setCheckboxWithoutEvent("switch-balance", data.balancing_switch);
    
    // 8. Render cell bars
    renderCellVoltageBars(data);
    
    // 9. Update live chart
    updateTrendChart(data);
}

function updateTempProgressBar(barId, temp, maxSafeTemp) {
    const bar = document.getElementById(barId);
    const pct = Math.max(0, Math.min(100, (temp / maxSafeTemp) * 100));
    bar.style.width = `${pct}%`;
    bar.style.background = temp > maxSafeTemp - 15 ? "var(--color-danger)" : (temp > maxSafeTemp - 35 ? "var(--color-warning)" : "var(--color-balancing)");
}

function setCheckboxWithoutEvent(checkboxId, checked) {
    const cb = document.getElementById(checkboxId);
    cb.onchange = null;
    cb.checked = checked;
    cb.onchange = function() { confirmSwitchToggle(checkboxId.replace("switch-", ""), this); };
}

function confirmSwitchToggle(switchType, checkbox) {
    pendingSwitchType = switchType;
    pendingSwitchState = checkbox.checked;
    pendingSwitchCheckbox = checkbox;
    
    const modal = document.getElementById("confirm-modal");
    const modalText = document.getElementById("confirm-modal-text");
    
    let switchName = switchType === "charge" ? "Şarj MOSFET" : (switchType === "discharge" ? "Deşarj MOSFET" : "Aktif Dengeleme");
    const actionName = pendingSwitchState ? "AÇMAK" : "KAPATMAK";
    
    modalText.innerHTML = `<strong>${switchName}</strong> ünitesini <strong>${actionName}</strong> istediğinizden emin misiniz? <br><br>
        <span style="color:var(--color-danger)">UYARI: Karavan/Tekne çıkış enerjisi veya BMS koruma mantığı etkilenecektir!</span>`;
    
    modal.classList.remove("hidden");
    checkbox.checked = !pendingSwitchState; // Revert visually
}

async function closeConfirmModal(confirmed) {
    const modal = document.getElementById("confirm-modal");
    modal.classList.add("hidden");
    
    if (confirmed && pendingSwitchType !== null) {
        if (connectionState === "simulation") {
            // Update local mock states
            if (pendingSwitchType === "charge") mockEngineState.charging_switch = pendingSwitchState;
            else if (pendingSwitchType === "discharge") mockEngineState.discharging_switch = pendingSwitchState;
            else if (pendingSwitchType === "balance") mockEngineState.balancing_switch = pendingSwitchState;
            
            appendLogConsole(`Simüle Switch Değişti: ${pendingSwitchType} -> ${pendingSwitchState}`, "INFO");
            pendingSwitchCheckbox.checked = pendingSwitchState;
            
        } else if (connectionState === "connected_webble") {
            // Write Web Bluetooth commands directly
            let cmd_reg = pendingSwitchType === "charge" ? 0x90 : (pendingSwitchType === "discharge" ? 0x91 : 0x93);
            let state_byte = pendingSwitchState ? 0x01 : 0x00;
            const commandFrame = buildJSCommandFrame(cmd_reg, state_byte);
            
            try {
                await writeWebBleCharacteristic(commandFrame);
                appendLogConsole(`BMS komut yazma başarılı (${pendingSwitchType.toUpperCase()})`, "INFO");
                pendingSwitchCheckbox.checked = pendingSwitchState;
            } catch (e) {
                alert(`Komut gönderilemedi: ${e.message}`);
                pendingSwitchCheckbox.checked = !pendingSwitchState;
            }
            
        } else if (connectionState === "connected_gateway") {
            // Forward commands over Gateway WebSocket
            if (gatewaySocket && gatewaySocket.readyState === WebSocket.OPEN) {
                gatewaySocket.send(JSON.stringify({
                    action: "control_switch",
                    switch: pendingSwitchType,
                    state: pendingSwitchState
                }));
                // Gateway will reply and update state
            }
        }
    } else {
        appendLogConsole("Kontrol işlemi iptal edildi.", "INFO");
        if (pendingSwitchCheckbox) {
            pendingSwitchCheckbox.checked = !pendingSwitchState;
        }
    }
    
    pendingSwitchType = null;
    pendingSwitchState = null;
    pendingSwitchCheckbox = null;
}

// ==========================================
// SIMULATION ENGINE (JS OFFLINE MOCK)
// ==========================================
const mockEngineState = {
    cell_count: 16,
    soc: 78.5,
    nominal_capacity: 280,
    remaining_capacity: 220,
    cycle_count: 45,
    cell_voltages: [],
    cell_resistances: [],
    charging_switch: true,
    discharging_switch: true,
    balancing_switch: true,
    alarm_flags: 0,
    temp_probe_1: 26.4,
    temp_probe_2: 27.2,
    temp_mos: 31.8
};

function activateSimulation() {
    stopSimulation();
    stopAllHardwareConnections();
    
    connectionState = 'simulation';
    updateConnectionUI();
    
    appendLogConsole("Mobil Çevrimdışı Simülasyon başlatılıyor...", "INFO");
    
    // Init voltages
    mockEngineState.cell_voltages = Array.from({length: 16}, () => 3.29 + (Math.random() - 0.5) * 0.02);
    mockEngineState.cell_resistances = Array.from({length: 16}, () => 0.9 + Math.random() * 0.4);
    
    // Clean chart
    chartDataPoints.labels = [];
    chartDataPoints.voltage = [];
    chartDataPoints.current = [];
    chartDataPoints.power = [];
    chartDataPoints.cells = [];
    if (liveChart) {
        rebuildChartDatasets();
    }
    
    simulationInterval = setInterval(() => {
        // Calculate current
        let current = 0;
        if (mockEngineState.charging_switch && !mockEngineState.discharging_switch) {
            current = 28.5 + (Math.random() - 0.5) * 0.4;
        } else if (mockEngineState.discharging_switch && !mockEngineState.charging_switch) {
            current = -32.8 + (Math.random() - 0.5) * 0.6;
        } else if (mockEngineState.charging_switch && mockEngineState.discharging_switch) {
            let t = Date.now() / 10000;
            current = 14 * Math.sin(t) + (Math.random() - 0.5) * 0.2;
        }
        
        // Update capacity & soc
        mockEngineState.remaining_capacity = Math.max(0, Math.min(mockEngineState.nominal_capacity, mockEngineState.remaining_capacity + current / 3600));
        mockEngineState.soc = (mockEngineState.remaining_capacity / mockEngineState.nominal_capacity) * 100;
        
        // Update cell voltages
        const delta_charge = 0.001 * current;
        for (let i = 0; i < mockEngineState.cell_count; i++) {
            let ir_drop = (mockEngineState.cell_resistances[i] / 1000.0) * current;
            mockEngineState.cell_voltages[i] += delta_charge * (0.9 + Math.random() * 0.2) + ir_drop * 0.005;
            mockEngineState.cell_voltages[i] = Math.max(2.5, Math.min(4.2, mockEngineState.cell_voltages[i]));
        }
        
        // Active balancing simulation
        let max_v = Math.max(...mockEngineState.cell_voltages);
        let min_v = Math.min(...mockEngineState.cell_voltages);
        let delta = max_v - min_v;
        let balancing_cells = Array(16).fill(false);
        let balancing_active = false;
        
        if (mockEngineState.balancing_switch && delta > 0.012 && current > -3.0) {
            balancing_active = true;
            let max_idx = mockEngineState.cell_voltages.indexOf(max_v);
            let min_idx = mockEngineState.cell_voltages.indexOf(min_v);
            mockEngineState.cell_voltages[max_idx] -= 0.0004;
            mockEngineState.cell_voltages[min_idx] += 0.0004;
            
            balancing_cells[max_idx] = true;
            balancing_cells[min_idx] = true;
        }
        
        // Update temperatures
        let loss = (current ** 2) * 0.00025;
        mockEngineState.temp_mos = Math.max(20, Math.min(85, 30.5 + loss + (Math.random() - 0.5) * 0.1));
        mockEngineState.temp_probe_1 = Math.max(20, Math.min(65, 25.5 + loss * 0.4 + (Math.random() - 0.5) * 0.05));
        mockEngineState.temp_probe_2 = Math.max(20, Math.min(65, 26.2 + loss * 0.5 + (Math.random() - 0.5) * 0.05));
        
        let sum_voltage = mockEngineState.cell_voltages.reduce((a,b)=>a+b, 0);
        
        // Broadcast telemetry
        const mockTelemetry = {
            model_name: "JK-B2A24S20P (Simülasyon)",
            bms_id: "OFFLINE_MOCK_16S",
            cell_count: mockEngineState.cell_count,
            cell_voltages: mockEngineState.cell_voltages,
            cell_resistances: mockEngineState.cell_resistances,
            total_voltage: sum_voltage,
            current: current,
            power: sum_voltage * current,
            soc: mockEngineState.soc,
            capacity_nominal: mockEngineState.nominal_capacity,
            capacity_remaining: mockEngineState.remaining_capacity,
            cycle_count: mockEngineState.cycle_count,
            max_cell_voltage: max_v,
            min_cell_voltage: min_v,
            max_cell_index: mockEngineState.cell_voltages.indexOf(max_v) + 1,
            min_cell_index: mockEngineState.cell_voltages.indexOf(min_v) + 1,
            cell_delta: delta,
            average_cell_voltage: sum_voltage / mockEngineState.cell_count,
            temperatures: {
                probe_1: mockEngineState.temp_probe_1,
                probe_2: mockEngineState.temp_probe_2,
                mos: mockEngineState.temp_mos
            },
            charging_switch: mockEngineState.charging_switch,
            discharging_switch: mockEngineState.discharging_switch,
            balancing_switch: mockEngineState.balancing_switch,
            balancing_active: balancing_active,
            balancing_cells: balancing_cells,
            alarm_flags: mockEngineState.alarm_flags,
            alerts: parseJSAlarms(mockEngineState.alarm_flags)
        };
        
        handleTelemetryUpdate(mockTelemetry);
        
    }, 1000);
}

function stopSimulation() {
    if (simulationInterval) {
        clearInterval(simulationInterval);
        simulationInterval = null;
    }
}

function toggleMockAlarm(bit, btn) {
    if (connectionState !== "simulation") return;
    const isEnabling = !btn.classList.contains("active");
    
    if (isEnabling) {
        mockEngineState.alarm_flags |= (1 << bit);
        btn.classList.add("active");
    } else {
        mockEngineState.alarm_flags &= ~(1 << bit);
        btn.classList.remove("active");
    }
}

function stopAllHardwareConnections() {
    // 1. Web BLE disconnect
    if (webBleDevice && webBleDevice.gatt.connected) {
        webBleDevice.gatt.disconnect();
    }
    if (webBlePollInterval) {
        clearInterval(webBlePollInterval);
    }
    
    // 2. Gateway WebSocket disconnect
    if (gatewaySocket) {
        gatewaySocket.close();
        gatewaySocket = null;
    }
}

function disconnectDevice() {
    stopAllHardwareConnections();
    activateSimulation();
}

function updateConnectionUI() {
    const badge = document.getElementById("connection-status-badge");
    badge.className = "status-indicator";
    
    const webBleStatusBox = document.getElementById("webble-status-box");
    const webBleStatusVal = document.getElementById("webble-conn-status");
    
    if (connectionState === "simulation") {
        badge.textContent = "Simülasyon";
        badge.classList.add("status-sim");
        webBleStatusBox.classList.add("hidden");
    } else if (connectionState === "connected_webble") {
        badge.textContent = "Direct BLE";
        badge.classList.add("status-connected");
        webBleStatusBox.classList.remove("hidden");
        webBleStatusVal.textContent = "Bağlı";
    } else if (connectionState === "connected_gateway") {
        badge.textContent = "Ağ Geçidi";
        badge.classList.add("status-connected");
        webBleStatusBox.classList.add("hidden");
    } else if (connectionState === "connecting") {
        badge.textContent = "Bağlanıyor...";
        badge.classList.add("status-connecting");
    } else {
        badge.textContent = "Bağlantı Yok";
        badge.classList.add("status-disconnected");
        webBleStatusBox.classList.add("hidden");
    }
    
    const discBtn = document.getElementById("btn-disconnect");
    if (connectionState !== "simulation" && connectionState !== "disconnected") {
        discBtn.classList.remove("hidden");
    } else {
        discBtn.classList.add("hidden");
    }
}

// ==========================================
// CELL VOLTAGE MONITOR BARS
// ==========================================
function renderCellVoltageBars(data) {
    const container = document.getElementById("cell-bars-container");
    const detailsGrid = document.getElementById("cell-details-grid");
    
    container.innerHTML = "";
    detailsGrid.innerHTML = "";
    
    const voltages = data.cell_voltages;
    const resistances = data.cell_resistances || Array(voltages.length).fill(1.0);
    const balancing_cells = data.balancing_cells || Array(voltages.length).fill(false);
    
    if (!voltages || voltages.length === 0) return;
    
    const max_v = Math.max(...voltages);
    const min_v = Math.min(...voltages);
    
    let chart_max = max_v + 0.015;
    let chart_min = min_v - 0.015;
    
    if (chart_max - chart_min < 0.05) {
        const mid = (chart_max + chart_min) / 2;
        chart_max = mid + 0.025;
        chart_min = mid - 0.025;
    }
    
    document.getElementById("y-axis-max").textContent = `${chart_max.toFixed(2)}V`;
    document.getElementById("y-axis-mid").textContent = `${((chart_max + chart_min)/2).toFixed(2)}V`;
    document.getElementById("y-axis-min").textContent = `${chart_min.toFixed(2)}V`;
    
    voltages.forEach((voltage, idx) => {
        const cell_id = idx + 1;
        const res = resistances[idx] || 1.0;
        const is_balancing = balancing_cells[idx];
        
        let pct = ((voltage - chart_min) / (chart_max - chart_min)) * 100;
        pct = Math.max(2, Math.min(100, pct));
        
        let colClass = "cell-bar-column";
        if (cell_id === data.max_cell_index) colClass += " max-cell";
        else if (cell_id === data.min_cell_index) colClass += " min-cell";
        if (is_balancing) colClass += " balancing-cell";
        
        const barColumn = document.createElement("div");
        barColumn.className = colClass;
        barColumn.innerHTML = `
            <div class="balancer-indicator"></div>
            <div class="cell-bar-container">
                <div class="cell-bar-fill" style="height: ${pct}%"></div>
            </div>
            <div class="cell-bar-label">${cell_id}</div>
        `;
        container.appendChild(barColumn);
        
        let blockClass = "cell-detail-block";
        let badgeHtml = "";
        if (cell_id === data.max_cell_index) {
            blockClass += " max-cell-border";
            badgeHtml = `<span class="cell-badge badge-max">MAX</span>`;
        } else if (cell_id === data.min_cell_index) {
            blockClass += " min-cell-border";
            badgeHtml = `<span class="cell-badge badge-min">MIN</span>`;
        }
        if (is_balancing) {
            blockClass += " balancing-cell-border";
        }
        
        const detailBlock = document.createElement("div");
        detailBlock.className = blockClass;
        detailBlock.innerHTML = `
            <h4>HÜCRE ${cell_id} ${badgeHtml}</h4>
            <div class="cell-volts">${voltage.toFixed(3)} V</div>
            <div class="cell-res">${res.toFixed(1)} mΩ</div>
        `;
        detailsGrid.appendChild(detailBlock);
    });
}

// ==========================================
// LIVE CHART CONTROLLER (CHART.JS)
// ==========================================
function initChart() {
    const ctx = document.getElementById('liveTrendChart').getContext('2d');
    liveChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: chartDataPoints.labels,
            datasets: []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#7e8b9b', font: { size: 9, family: 'Inter' } }
                }
            },
            scales: {}
        }
    });
    
    rebuildChartDatasets();
}

function rebuildChartDatasets() {
    if (!liveChart) return;
    
    if (currentChartType === 'general') {
        liveChart.data.datasets = [
            {
                label: 'Voltaj (V)',
                yAxisID: 'y-voltage',
                data: chartDataPoints.voltage,
                borderColor: '#ffea00',
                borderWidth: 2,
                pointRadius: 0,
                fill: false,
                tension: 0.15
            },
            {
                label: 'Akım (A)',
                yAxisID: 'y-current',
                data: chartDataPoints.current,
                borderColor: '#00e5ff',
                borderWidth: 2,
                pointRadius: 0,
                fill: false,
                tension: 0.15
            }
        ];
        
        liveChart.options.scales = {
            x: {
                grid: { color: 'rgba(255, 255, 255, 0.02)' },
                ticks: { color: '#7e8b9b', font: { size: 8 } }
            },
            'y-voltage': {
                type: 'linear',
                display: true,
                position: 'left',
                grid: { color: 'rgba(255, 255, 255, 0.04)' },
                ticks: { color: '#ffea00', font: { size: 8 } },
                title: { display: true, text: 'Gerilim (V)', color: '#ffea00', font: { size: 9 } }
            },
            'y-current': {
                type: 'linear',
                display: true,
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { color: '#00e5ff', font: { size: 8 } },
                title: { display: true, text: 'Akım (A)', color: '#00e5ff', font: { size: 9 } }
            }
        };
    } else if (currentChartType === 'power') {
        liveChart.data.datasets = [
            {
                label: 'Güç (W)',
                data: chartDataPoints.power,
                borderColor: '#00ff88',
                backgroundColor: 'rgba(0, 255, 136, 0.05)',
                borderWidth: 2.5,
                pointRadius: 0,
                fill: true,
                tension: 0.15
            }
        ];
        
        liveChart.options.scales = {
            x: {
                grid: { color: 'rgba(255, 255, 255, 0.02)' },
                ticks: { color: '#7e8b9b', font: { size: 8 } }
            },
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                grid: { color: 'rgba(255, 255, 255, 0.04)' },
                ticks: { color: '#00ff88', font: { size: 8 } },
                title: { display: true, text: 'Güç (W)', color: '#00ff88', font: { size: 9 } }
            }
        };
    } else if (currentChartType === 'cells') {
        const numCells = chartDataPoints.cells.length;
        const cellDatasets = [];
        
        for (let i = 0; i < numCells; i++) {
            cellDatasets.push({
                label: `Hücre ${i + 1}`,
                data: chartDataPoints.cells[i],
                borderColor: `hsl(${(i * 360 / Math.max(1, numCells)) % 360}, 75%, 60%)`,
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false,
                tension: 0.1
            });
        }
        
        liveChart.data.datasets = cellDatasets;
        liveChart.options.scales = {
            x: {
                grid: { color: 'rgba(255, 255, 255, 0.02)' },
                ticks: { color: '#7e8b9b', font: { size: 8 } }
            },
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                grid: { color: 'rgba(255, 255, 255, 0.04)' },
                ticks: { color: '#7e8b9b', font: { size: 8 } },
                title: { display: true, text: 'Hücre Voltajı (V)', color: '#7e8b9b', font: { size: 9 } },
                suggestedMin: 2.8,
                suggestedMax: 3.6
            }
        };
    }
    
    liveChart.update();
}

function setChartType(type) {
    currentChartType = type;
    
    // Toggle active styles on custom header button classes
    const buttons = document.querySelectorAll(".chart-toggle-buttons .tab-btn");
    buttons.forEach(btn => {
        btn.classList.remove("active");
        btn.style.border = "1px solid transparent";
        btn.style.background = "transparent";
        btn.style.color = "#7e8b9b";
    });
    
    const activeBtnId = `btn-chart-${type}`;
    const activeBtn = document.getElementById(activeBtnId);
    if (activeBtn) {
        activeBtn.classList.add("active");
        activeBtn.style.border = "1px solid rgba(0, 229, 255, 0.2)";
        activeBtn.style.background = "rgba(0, 229, 255, 0.05)";
        activeBtn.style.color = "#00e5ff";
    }
    
    rebuildChartDatasets();
}

function updateTrendChart(data) {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    chartDataPoints.labels.push(timestamp);
    chartDataPoints.voltage.push(data.total_voltage);
    chartDataPoints.current.push(data.current);
    chartDataPoints.power.push(data.total_voltage * data.current);
    
    if (data.cell_voltages && data.cell_voltages.length > 0) {
        const numCells = data.cell_voltages.length;
        if (chartDataPoints.cells.length !== numCells) {
            chartDataPoints.cells = Array.from({ length: numCells }, () => []);
        }
        for (let i = 0; i < numCells; i++) {
            chartDataPoints.cells[i].push(data.cell_voltages[i]);
        }
    }
    
    // Maintain a large historical rolling buffer (3000 data points, about 3 hours of records)
    const MAX_POINTS = 3000;
    if (chartDataPoints.labels.length > MAX_POINTS) {
        chartDataPoints.labels.shift();
        chartDataPoints.voltage.shift();
        chartDataPoints.current.shift();
        chartDataPoints.power.shift();
        
        if (chartDataPoints.cells && chartDataPoints.cells.length > 0) {
            for (let i = 0; i < chartDataPoints.cells.length; i++) {
                chartDataPoints.cells[i].shift();
            }
        }
    }
    
    if (liveChart) {
        if (currentChartType === 'cells' && liveChart.data.datasets.length !== chartDataPoints.cells.length) {
            rebuildChartDatasets();
        } else {
            liveChart.update('none');
        }
    }
}

// ==========================================
// GENERAL UI HANDLERS
// ==========================================
function switchTab(tabName) {
    currentTab = tabName;
    
    const buttons = document.querySelectorAll(".sidebar-tabs .tab-btn");
    buttons.forEach((btn, idx) => {
        if ((tabName === 'simulation' && idx === 0) || 
            (tabName === 'webble' && idx === 1) || 
            (tabName === 'gateway' && idx === 2)) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
    
    document.getElementById("tab-simulation").classList.remove("active");
    document.getElementById("tab-webble").classList.remove("active");
    document.getElementById("tab-gateway").classList.remove("active");
    
    document.getElementById(`tab-${tabName}`).classList.add("active");
}

function appendLogConsole(message, level = "INFO", timestamp = null) {
    const consoleBody = document.getElementById("console-logs");
    if (!consoleBody) return;
    
    const timeStr = timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = `<span class="log-time">[${timeStr}]</span><span class="log-level-${level}">[${level}]</span> ${message}`;
    
    consoleBody.appendChild(line);
    while (consoleBody.children.length > 80) {
        consoleBody.removeChild(consoleBody.firstChild);
    }
    consoleBody.scrollTop = consoleBody.scrollHeight;
}

function clearConsole() {
    const consoleBody = document.getElementById("console-logs");
    if (consoleBody) consoleBody.innerHTML = "";
}
