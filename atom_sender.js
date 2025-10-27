// atom sender
const { SigningStargateClient } = require('@cosmjs/stargate');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { stringToPath } = require('@cosmjs/crypto');
const xlsx = require('xlsx');
const fs = require('fs');

// Pentru Node.js < 18, folosește node-fetch
let fetch;
try {
    fetch = globalThis.fetch;
} catch (e) {
    fetch = require('node-fetch');
}

// Configurare rețea Cosmos Hub
const COSMOS_CONFIG = {
    rpcEndpoint: 'https://cosmos-rpc.polkachu.com', // Endpoint funcțional pentru Cosmos Hub
    chainId: 'cosmoshub-4', // Chain ID pentru Cosmos Hub
    prefix: 'cosmos',
    gasPrice: '0.025uatom',
    gasLimit: '200000',
    // Rate limiting settings
    delayBetweenTransactions: 0, // 0 secunde între tranzacții
    maxRetries: 3, // Numărul maxim de încercări pentru o tranzacție
    retryDelay: 5000, // 5 secunde între încercări
    // Fee settings
    reservedAtomForFees: 0.02 // Rezervă 0.02 ATOM pentru fees
};

/**
 * Funcție pentru așteptare cu retry exponential
 * @param {number} delay - Delay-ul în milisecunde
 * @param {number} attempt - Numărul încercării curente
 * @returns {Promise<void>}
 */
async function sleepWithBackoff(delay, attempt = 1) {
    const backoffDelay = delay * Math.pow(2, attempt - 1);
    console.log(`   ⏳ Așteptare ${backoffDelay/1000}s înainte de încercarea ${attempt}...`);
    await new Promise(resolve => setTimeout(resolve, backoffDelay));
}

/**
 * Verifică statusul RPC endpoint-ului
 * @returns {Promise<boolean>} - true dacă endpoint-ul este funcțional
 */
async function checkRpcEndpointStatus() {
    try {
        console.log(`🔍 Verificare status RPC endpoint: ${COSMOS_CONFIG.rpcEndpoint}`);
        const response = await fetch(`${COSMOS_CONFIG.rpcEndpoint}/status`);
        
        if (response.ok) {
            const data = await response.json();
            console.log(`✅ RPC endpoint funcțional - Chain ID: ${data.result?.node_info?.network || 'unknown'}`);
            return true;
        } else {
            console.log(`❌ RPC endpoint returnează status ${response.status}`);
            return false;
        }
    } catch (error) {
        console.log(`❌ Eroare la verificarea RPC endpoint: ${error.message}`);
        return false;
    }
}

/**
 * Verifică dacă o tranzacție a fost confirmată pe blockchain
 * @param {string} transactionHash - Hash-ul tranzacției
 * @param {number} maxWaitTime - Timpul maxim de așteptare în milisecunde (default: 120000 = 2 minute)
 * @returns {Promise<boolean>} - true dacă tranzacția este confirmată
 */
async function waitForTransactionConfirmation(transactionHash, maxWaitTime = 120000) {
    const startTime = Date.now();
    const checkInterval = 5000; // Verifică la fiecare 5 secunde
    
    console.log(`   🔍 Așteptare confirmare tranzacție: ${transactionHash}`);
    
    while (Date.now() - startTime < maxWaitTime) {
        try {
            // Încearcă să obțină informațiile despre tranzacție
            const response = await fetch(`${COSMOS_CONFIG.rpcEndpoint}/tx?hash=0x${transactionHash}`);
            
            if (response.ok) {
                const data = await response.json();
                
                if (data.result && data.result.tx_result && data.result.tx_result.code === 0) {
                    console.log(`   ✅ Tranzacția confirmată în ${Math.round((Date.now() - startTime) / 1000)} secunde`);
                    return true;
                } else if (data.result && data.result.tx_result && data.result.tx_result.code !== 0) {
                    console.log(`   ❌ Tranzacția eșuată cu codul: ${data.result.tx_result.code}`);
                    return false;
                }
            }
            
            // Dacă nu găsește tranzacția, așteaptă
            console.log(`   ⏳ Tranzacția nu este încă confirmată, așteptare ${checkInterval/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            
        } catch (error) {
            console.log(`   ⚠️  Eroare la verificarea tranzacției: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
    }
    
    console.log(`   ⏰ Timeout: Tranzacția nu a fost confirmată în ${maxWaitTime/1000} secunde`);
    return false;
}

/**
 * Trimite ATOM către o adresă Cosmos cu retry pentru rate limiting
 * @param {string} seedPhrase - Seed phrase al wallet-ului sursă
 * @param {string} toAddress - Adresa destinatară Cosmos
 * @param {string} amount - Cantitatea ATOM (ignorată - se calculează automat)
 * @returns {Promise<Object>} - Rezultatul tranzacției
 */
async function sendAtom(seedPhrase, toAddress, amount = "1.0") {
    let lastError = null;
    
    for (let attempt = 1; attempt <= COSMOS_CONFIG.maxRetries; attempt++) {
        try {
            console.log(`\n🚀 Pregătire tranzacție ATOM (încercarea ${attempt}/${COSMOS_CONFIG.maxRetries}):`);
            console.log(`   De la: ${seedPhrase.substring(0, 20)}...`);
            console.log(`   Către: ${toAddress}`);
            console.log(`   Cantitate: Balanța ATOM minus ${COSMOS_CONFIG.reservedAtomForFees} ATOM pentru fees`);

            // Creează wallet-ul din seed phrase
            const wallet = await DirectSecp256k1HdWallet.fromMnemonic(seedPhrase, {
                prefix: COSMOS_CONFIG.prefix,
                hdPaths: [stringToPath("m/44'/118'/0'/0/0")] // Cosmos standard path
            });

            // Obține adresa wallet-ului
            const [account] = await wallet.getAccounts();
            const fromAddress = account.address;
            
            console.log(`   Adresa sursă: ${fromAddress}`);

            // Creează client-ul Stargate cu endpoint-ul funcțional
            console.log(`   🔗 Conectare la: ${COSMOS_CONFIG.rpcEndpoint}`);
            const client = await SigningStargateClient.connectWithSigner(
                COSMOS_CONFIG.rpcEndpoint,
                wallet,
                {
                    prefix: COSMOS_CONFIG.prefix,
                    gasPrice: COSMOS_CONFIG.gasPrice
                }
            );
            console.log(`   ✅ Conectat cu succes!`);

            // Verifică balanța ATOM înainte de trimitere
            console.log(`   🔍 Verificare balanță ATOM pentru: ${fromAddress}`);
            const balance = await client.getBalance(fromAddress, 'uatom');
            console.log(`   💰 Balanța ATOM curentă: ${balance.amount} ${balance.denom}`);
            
            // Obține informații despre cont
            const accountInfo = await client.getAccount(fromAddress);
            console.log(`   📋 Account info:`, {
                accountNumber: accountInfo?.accountNumber,
                sequence: accountInfo?.sequence,
                chainId: COSMOS_CONFIG.chainId
            });
            
            // Obține întotdeauna sequence-ul curent din blockchain
            const freshAccountInfo = await client.getAccount(fromAddress);
            let currentSequence = freshAccountInfo?.sequence || 0;
            console.log(`   🔢 Sequence curent din blockchain: ${currentSequence}`);

            // Calculează cantitatea de trimis (balanța totală minus rezerva pentru fees)
            const totalBalance = parseInt(balance.amount);
            const reservedForFees = Math.floor(COSMOS_CONFIG.reservedAtomForFees * 1000000); // 0.02 ATOM în uatom
            const amountToSend = totalBalance - reservedForFees;
            
            console.log(`   💰 Balanța totală: ${totalBalance} uatom`);
            console.log(`   🔒 Rezervă pentru fees: ${reservedForFees} uatom (${COSMOS_CONFIG.reservedAtomForFees} ATOM)`);
            console.log(`   📤 Cantitate de trimis: ${amountToSend} uatom`);

            // Verifică dacă există suficientă balanță pentru trimitere
            if (amountToSend <= 0) {
                console.log(`   ⏭️  Skip: Balanța insuficientă pentru trimitere (necesar: ${reservedForFees} uatom pentru fees)`);
                return {
                    success: false,
                    error: `SKIP: Insufficient balance for transfer (need ${reservedForFees} uatom for fees)`,
                    fromAddress: fromAddress,
                    toAddress: toAddress,
                    amount: '0uatom',
                    timestamp: new Date().toISOString(),
                    confirmed: false
                };
            }

            // Creează mesajul de transfer
            const msg = {
                typeUrl: "/cosmos.bank.v1beta1.MsgSend",
                value: {
                    fromAddress: fromAddress,
                    toAddress: toAddress,
                    amount: [{
                        denom: "uatom",
                        amount: amountToSend.toString()
                    }]
                }
            };

            // Trimite tranzacția
            console.log(`   📤 Trimitere tranzacție...`);
            const result = await client.signAndBroadcast(
                fromAddress,
                [msg],
                {
                    amount: [{ denom: "uatom", amount: "5000" }], // Gas fee în uatom
                    gas: COSMOS_CONFIG.gasLimit
                }
            );

            console.log(`   📤 Tranzacție trimisă!`);
            console.log(`   📋 Hash tranzacție: ${result.transactionHash}`);
            console.log(`   📊 Gas folosit: ${result.gasUsed}`);

            // Așteaptă confirmarea tranzacției
            const isConfirmed = await waitForTransactionConfirmation(result.transactionHash);
            
            if (isConfirmed) {
                console.log(`   ✅ Tranzacția confirmată cu succes!`);
                return {
                    success: true,
                    transactionHash: result.transactionHash,
                    gasUsed: result.gasUsed,
                    fromAddress: fromAddress,
                    toAddress: toAddress,
                    amount: `${amountToSend}uatom`,
                    timestamp: new Date().toISOString(),
                    confirmed: true
                };
            } else {
                console.log(`   ⚠️  Tranzacția trimisă dar nu confirmată în timp util`);
                return {
                    success: false,
                    transactionHash: result.transactionHash,
                    error: 'Transaction not confirmed in time',
                    fromAddress: fromAddress,
                    toAddress: toAddress,
                    amount: `${amountToSend}uatom`,
                    timestamp: new Date().toISOString(),
                    confirmed: false
                };
            }

        } catch (error) {
            lastError = error;
            console.error(`   ❌ Eroare la trimiterea ATOM (încercarea ${attempt}):`, error.message);
            
            // Verifică dacă este o eroare de rate limiting (429) sau alte erori temporare
            const isRateLimitError = error.message.includes('429') || 
                                   error.message.includes('Too Many Requests') ||
                                   error.message.includes('rate limit') ||
                                   error.message.includes('Bad status on response: 429');
            
            if (isRateLimitError && attempt < COSMOS_CONFIG.maxRetries) {
                console.log(`   🔄 Eroare de rate limiting detectată. Încercare din nou...`);
                await sleepWithBackoff(COSMOS_CONFIG.retryDelay, attempt);
                continue;
            } else if (attempt < COSMOS_CONFIG.maxRetries) {
                console.log(`   🔄 Eroare temporară detectată. Încercare din nou...`);
                await sleepWithBackoff(COSMOS_CONFIG.retryDelay, attempt);
                continue;
            } else {
                console.error(`   ❌ Toate încercările au eșuat pentru ${toAddress}`);
                break;
            }
        }
    }
    
    // Dacă ajungem aici, toate încercările au eșuat
    return {
        success: false,
        error: lastError ? lastError.message : 'Toate încercările au eșuat',
        fromAddress: '',
        toAddress: toAddress,
        amount: amount,
        timestamp: new Date().toISOString()
    };
}

/**
 * Procesează fișierul Excel cu adresele și trimite ATOM
 * @param {string} inputFile - Fișierul Excel de intrare
 * @param {string} outputFile - Fișierul Excel de ieșire
 */
async function processExcelFile(inputFile, outputFile) {
    try {
        console.log(`📖 Citirea fișierului: ${inputFile}`);
        
        // Verifică dacă fișierul există
        if (!fs.existsSync(inputFile)) {
            throw new Error(`Fișierul ${inputFile} nu există! Asigură-te că fișierul este în același director cu scriptul.`);
        }
        
        // Verifică statusul RPC endpoint-ului înainte de a începe
        console.log(`\n🔍 Verificare conectivitate RPC...`);
        const isRpcHealthy = await checkRpcEndpointStatus();
        if (!isRpcHealthy) {
            console.log(`⚠️  RPC endpoint pare să aibă probleme, dar continuăm...`);
        }
        
        const workbook = xlsx.readFile(inputFile);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const range = xlsx.utils.decode_range(worksheet['!ref']);

        console.log(`Range: ${worksheet['!ref']}`);
        
        const totalRows = range.e.r - range.s.r + 1;
        console.log(`\n🚀 Începe procesarea a ${totalRows} rânduri din fișierul Excel...`);
        console.log(`💰 Toate adresele vor primi balanța ATOM minus ${COSMOS_CONFIG.reservedAtomForFees} ATOM pentru fees`);
        console.log(`⏱️  Verificare confirmare tranzacții în timp real pe blockchain`);
        console.log(`🔄 Configurare rate limiting:`);
        console.log(`   - Delay între tranzacții: ${COSMOS_CONFIG.delayBetweenTransactions/1000}s`);
        console.log(`   - Max încercări per tranzacție: ${COSMOS_CONFIG.maxRetries}`);
        console.log(`   - Delay între încercări: ${COSMOS_CONFIG.retryDelay/1000}s\n`);
        
        // Procesează fiecare rând
        let processedCount = 0;
        let successfulTransfers = 0;
        let failedTransfers = 0;
        let skippedTransfers = 0;
        let seedPhrase = '';
        
        for (let row = range.s.r; row <= range.e.r; row++) {
            const addressCell = `A${row + 1}`;
            const seedCell = `B${row + 1}`;
            const resultCell = `C${row + 1}`;
            
            if (worksheet[addressCell]) {
                const address = worksheet[addressCell].v;
                const currentSeed = worksheet[seedCell] ? worksheet[seedCell].v : '';
                
                processedCount++;
                
                console.log(`\n[${processedCount}/${totalRows}] Procesare rând ${row + 1}: ${address}`);
                
                if (typeof address === 'string' && address.startsWith('cosmos1')) {
                    // Folosește seed-ul din coloana B sau cel anterior
                    const seedToUse = currentSeed || seedPhrase;
                    
                    if (!seedToUse) {
                        worksheet[resultCell] = { v: 'NO_SEED_PHRASE', t: 's' };
                        console.log(`❌ Nu există seed phrase pentru rândul ${row + 1}`);
                        failedTransfers++;
                        continue;
                    }
                    
                    // Salvează seed-ul pentru următoarele rânduri
                    if (currentSeed) {
                        seedPhrase = currentSeed;
                    }
                    
                    // Trimite ATOM
                    const result = await sendAtom(seedToUse, address);
                    
                    if (result.success) {
                        worksheet[resultCell] = { v: `SUCCESS: ${result.transactionHash}`, t: 's' };
                        successfulTransfers++;
                        console.log(`✅ ATOM trimis cu succes către ${address}`);
                    } else if (result.error && result.error.startsWith('SKIP:')) {
                        worksheet[resultCell] = { v: `SKIP: ${result.error}`, t: 's' };
                        skippedTransfers++;
                        console.log(`⏭️  Skip: ${result.error}`);
                    } else {
                        worksheet[resultCell] = { v: `FAILED: ${result.error}`, t: 's' };
                        failedTransfers++;
                        console.log(`❌ Eșec la trimiterea ATOM către ${address}: ${result.error}`);
                    }
                    
                    // Salvează la fiecare 5 tranzacții
                    if (processedCount % 5 === 0) {
                        console.log(`\n💾 Salvare progres la ${processedCount} tranzacții procesate...`);
                        xlsx.writeFile(workbook, outputFile);
                        console.log(`✅ Progres salvat în: ${outputFile}`);
                    }
                    
                    // Pauză între tranzacții pentru a evita rate limiting
                    if (processedCount < totalRows) {
                        console.log(`   ⏳ Așteptare ${COSMOS_CONFIG.delayBetweenTransactions/1000}s între tranzacții...`);
                        await new Promise(resolve => setTimeout(resolve, COSMOS_CONFIG.delayBetweenTransactions));
                    }
                    
                } else {
                    worksheet[resultCell] = { v: 'INVALID_ADDRESS', t: 's' };
                    console.log(`❌ Adresă Cosmos invalidă: ${address}`);
                    failedTransfers++;
                }
            } else {
                // Dacă nu există celula A, creează celula C goală
                worksheet[resultCell] = { v: '', t: 's' };
            }
        }
        
        console.log(`\n📊 Rezumat procesare:`);
        console.log(`   Total rânduri procesate: ${processedCount}`);
        console.log(`   Tranzacții reușite: ${successfulTransfers}`);
        console.log(`   Tranzacții eșuate: ${failedTransfers}`);
        console.log(`   Tranzacții skip-uite: ${skippedTransfers}`);
        
        // Actualizează range-ul pentru a include coloana C
        const newRange = xlsx.utils.decode_range(worksheet['!ref']);
        newRange.e.c = Math.max(newRange.e.c, 2); // Asigură-te că coloana C este inclusă
        worksheet['!ref'] = xlsx.utils.encode_range(newRange);
        
        xlsx.writeFile(workbook, outputFile);
        console.log(`\n✅ Fișierul final a fost salvat ca: ${outputFile}`);
        return true;
        
    } catch (error) {
        console.error('Eroare la procesarea fișierului Excel:', error);
        throw error;
    }
}

/**
 * Testează trimiterea ATOM cu o singură adresă
 */
async function testSingleTransfer() {
    console.log('=== TESTARE TRIMITERE ATOM ===\n');
    
    // Adresă de test (înlocuiește cu adresa ta reală)
    const testAddress = 'cosmos1example123456789abcdefghijklmnopqrstuvwxyz';
    
    console.log('⚠️  ATENȚIE: Acest test va trimite ATOM real!');
    console.log('⚠️  Asigură-te că ai ATOM în wallet-ul de test!');
    console.log('⚠️  Adresa de test:', testAddress);
    console.log('\nPentru a continua, modifică scriptul cu seed-ul tău real.\n');
    
    // Exemplu de seed phrase (înlocuiește cu al tău real)
    const testSeed = 'your seed phrase here replace with real one';
    
    if (testSeed === 'your seed phrase here replace with real one') {
        console.log('❌ Modifică testSeed cu seed-ul tău real pentru a rula testul!');
        return;
    }
    
    const result = await sendAtom(testSeed, testAddress);
    
    console.log('\nRezultat test:');
    console.log(`Succes: ${result.success}`);
    if (result.success) {
        console.log(`Hash: ${result.transactionHash}`);
        console.log(`Gas folosit: ${result.gasUsed}`);
    } else {
        console.log(`Eroare: ${result.error}`);
    }
}

/**
 * Funcție principală
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('=== TRIMITOR ATOM COSMOS ===\n');
        console.log('Utilizare:');
        console.log('  node atom_sender.js test                                    # Testează cu o singură tranzacție');
        console.log('  node atom_sender.js send                                    # Trimite ATOM din cosmos_addresses.xlsx');
        console.log('  node atom_sender.js send input.xlsx                        # Trimite ATOM din fișier specificat');
        console.log('  node atom_sender.js send input.xlsx output.xlsx            # Specifică fișierul de ieșire');
        console.log('');
        console.log('Format Excel:');
        console.log('  Coloana A: Adrese Cosmos destinatare');
        console.log('  Coloana B: Seed phrase wallet sursă (același pentru toate)');
        console.log('  Coloana C: Rezultate tranzacții (va fi completată automat)');
        console.log('');
        console.log('⚠️  ATENȚIE: Acest script trimite ATOM real!');
        console.log(`⚠️  Rezervă ${COSMOS_CONFIG.reservedAtomForFees} ATOM pentru fees în fiecare wallet!`);
        console.log('⚠️  Asigură-te că ai suficientă balanță ATOM pentru trimitere și fees!');
        console.log('');
        return;
    }
    
    const command = args[0];
    
    switch (command) {
        case 'test':
            await testSingleTransfer();
            break;
            
        case 'send':
            // Folosește fișierul implicit sau cel specificat
            const inputFile = args[1] || 'cosmos_addresses.xlsx';
            const outputFile = args[2] || inputFile.replace('.xlsx', '_atom_sent.xlsx');
            
            console.log('⚠️  ATENȚIE: Acest script va trimite ATOM real!');
            console.log(`⚠️  Rezervă ${COSMOS_CONFIG.reservedAtomForFees} ATOM pentru fees în fiecare wallet!`);
            console.log('⚠️  Asigură-te că ai suficientă balanță ATOM pentru trimitere și fees!');
            console.log(`📁 Fișier intrare: ${inputFile}`);
            console.log(`📁 Fișier ieșire: ${outputFile}`);
            console.log('\nApasă Ctrl+C pentru a anula sau așteaptă 5 secunde...');
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            await processExcelFile(inputFile, outputFile);
            break;
            
        default:
            console.error('Comandă necunoscută. Folosește: test sau send');
    }
}

// Rulează scriptul dacă este apelat direct
if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    sendAtom,
    processExcelFile,
    testSingleTransfer
};

