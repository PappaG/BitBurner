/** director.js
*   direct activities of player servers
*   Nestscript 2.0 version
*/

var logFileName = "logFile.txt";
var moneyToDate = 0; //money hacked while running this script
var basicFileSet = ["hackOne.script", "growOne.script", "weakenOne.script", "balanceOne.script", "singleHack.script"];
var rescanIncrements = 5; // number of hack level increases before rescan
var minHackLevel = 100; // xp farm only untill we reach this level, then revert to money hacking
var targetListFile = "sortedTargets.txt";
var hostList = []; // list of servers to host
var activeTargets = []; // list of hacked servers usable for farming
var hackingServers = []; // list of servers used for hacking - not shared with swarm
var droneTotalRam = 0; // total ram of all available drones
var startTime, endTime; // to track time elapsed
var weakenRate = 0.05; // game constant
var hackSecImpact = 0.002; // game constant
var growSecImpact = 0.004; // game constant
var growWeakenRatio = weakenRate / (1 * 2.5 * growSecImpact); //  security reduction per weaken / security increase per grow
var playerHackLevelLastScan = 0; // set bechmark for re-scanning intervals

function Target(maxMoney, name, level, ports, ram) {
    this.maxMoney = maxMoney;
    this.name = name;
    this.level = level;
    this.ports = ports;
    this.ram = ram;
    this.baseSecurity = 0;
    this.minSecurity = 0;
    this.currentSecLevel = 0;
    this.growthRate = 0;
    this.moneyAvailable = 0; // ns.getServerMoneyAvailable(server);
    this.hackTime = 0; //getHackTime(server);
    this.growthTime = 0; //getGrowTime(server);
    this.weakenTime = 0; //getWeakenTime(server);
    this.hasBeenProfiled = false; // indicates whether static values have been added for this server
}

var xpFarmTarget = new Target();
var moneyFarmTarget = new Target();

// create Script object and fill with data for each file type
function Script(file, ram, threads) {
    this.file = file;
    this.ram = ram;
    this.threads = threads;
    this.percentage = 0; // store caculated hack or grow percentages
}

var hackScript = new Script();
var growScript = new Script();
var weakenScript = new Script();
var balanceScript = new Script();
var singleHackScript = new Script();

var player = {
    hackLevel: 0,
    money: 0,
    mults: 0,
    toolsLevel: 0, // number of hacking tools available e.g BruteSSH.exe
};

// --- main ---
//-------------------------------------------------------------------------------------------
export async function main(ns) {

    // complete variable declarations
    var moneyObjective = ns.args[0] || (89 * 1000000); // run script untill this money level is achieved
    var moneyFarmTargetName = ns.args[1] || "zer0";

    player.hackLevel = ns.getHackingLevel();
    player.money = ns.getServerMoneyAvailable("home");
    player.mults = ns.getHackingMultipliers();
    player.toolsLevel = 0; // number of hacking tools available e.g BruteSSH.exe
    playerHackLevelLastScan = player.hackLevel; // set bechmark for re-scanning intervals
    lastCheckMoney = player.money;

    hackScript = new Script("hackOne.script", ns.getScriptRam("hackOne.script"), 1);
    growScript = new Script("growOne.script", ns.getScriptRam("growOne.script"), 1);
    weakenScript = new Script("weakenOne.script", ns.getScriptRam("weakenOne.script"), 1);
    balanceScript = new Script("balanceOne.script", ns.getScriptRam("balanceOne.script"), 1);
    singleHackScript = new Script("singleHack.script", ns.getScriptRam("singleHack.script"), 1);

    startTimer(); // start the clock
    silencePlease(ns);  // simplify the log
    hostList = readTargetList(ns, targetListFile); // read the list of scanned servers

    ns.print("Doing initial jobs assignment");
    ns.tprint(">> Last chance to hack CSEC manualy. We will need their processing capacity soon");
    ns.tprint(">> Start building FTPCrack.exe under Create Programs if you have not yet done so.");
    scanTargets(ns, hostList); // scan for new hackable servers and hack them

    ns.tprint("Scan complete ...");

    // start the money farming cycle
    profileServer(ns, moneyFarmTarget, moneyFarmTargetName);
    ns.tprint(">> [Elapsed Time: " + elapsedMinutes() + "]");
    ns.tprint(">> Diverting all drones to farming for money on server :" + moneyFarmTarget.name);
    ns.tprint("   Money target is: " + asDollar(moneyObjective) + " on server " + moneyFarmTarget.name);
    ns.tprint("");

    // weaken server to minimum
    if (securityPercentage(ns, moneyFarmTarget) > 0.02) {
        weakenServerToMin(ns, moneyFarmTarget);
    } else {
        ns.tprint(">> Target server " + moneyFarmTarget.name + "already at low security (" + asPercentage(securityPercentage(ns, moneyFarmTarget)) + " ), skipping softening process : ");
    }

    //
    // rest of code ommitted to keep debugging simple
    //

}  //--- end of main ---


// --- functions ---

function fillDroneCapacity(ns, scriptN, target) {
    // fill up available capacity across all hacked servers with specified script
    // activeTargets[] is a global array containing all hacked servers as objects
    var availableRam = 0;
    var threadsAdded = 0; // count of threads added
    var i = 0; // looper

    // debug
    ns.print("Running script " + scriptN.file + " accross " + activeTargets.length + " servers");
    for (i = 0; i < activeTargets.length; ++i) {
        availableRam = activeTargets[i].ram - ns.getServerRam(activeTargets[i].name)[1];
        if (availableRam >= scriptN.ram) {
            //debug
            ns.print(">>pre runScript");
            threadsAdded += runScript(ns, activeTargets[i], scriptN, target);
            // >> debug check << - the following line of code is not executed and script just ends
            ns.print("fillDroneCapacity: threads at " + threadsAdded + " after server " + activeTargets[i].name);
        } else {
            ns.print("Server already at max capacity: " + activeTargets[i].name);
        }
    }

    ns.print("fillDroneCapacity: total threadsAdded = " + threadsAdded); 
    return threadsAdded;
}


async function runScript(ns, host, scriptN, target, nThreads) {
    // run maximum threads of single script on target server if nThreads omitted
    // if nThreads > 0, run same number of individual threads with a timestamp as last argument to differentiate them

    var addGhostArg = false; // should ghost arg be added to script to enable running multiple instances on same server
    addGhostArg = (nThreads > 0) || false;
    var res = ns.getServerRam(host.name);
    var availableRam = res[0] - res[1];
    var threads = nThreads || Math.floor(availableRam / scriptN.ram); // if nTreads falsy set it to maximum threads
    var timeStamp = Date.now(); // add this as unique arg if needed

    if (threads > 0) {
        if (addGhostArg) {
            await ns.exec(scriptN.file, host.name, threads, target.name, timeStamp);
        } else {
            await ns.exec(scriptN.file, host.name, threads, target.name);
        }
    } else {
        ns.print(">> Server already at max capacity :" + host.name);
    }

    ns.print("runScript: threads assigned = " + threads);  //debug << this runs fine
    return threads;
}


function silencePlease(ns) {
    // simplify output to log screen
    var silenceFunction = ["getHackingLevel", "getServerMinSecurityLevel", "getServerBaseSecurityLevel", "getServerSecurityLevel", "getServerMinSecurityLevel", "getServerRequiredHackingLevel",
        "getServerGrowth", "getServerMaxMoney", "getServerMoneyAvailable"
    ];
    var i = 0; // looper

    for (i = 0; i < silenceFunction.length; ++i) {
        ns.disableLog(silenceFunction[i]);
    }
    ns.clearLog();
    return;
}


function readTargetList(ns, filename) {
    // read in list of targets
    var rawList = []; // array to receive raw data pairs
    var maxLines = 999; // todo [ ] reset to 999 after testing 
    var i = 0; // looper

    ns.print("Reading list of potential targets from file.");
    rawList = ns.read(filename).split(",");
    ns.print("Parsing file in to array of :" + rawList.length);

    // debug - changing loop max to 5 items for speed
    //for (i = 0; i < 7; ++i) {
    // debug - reinstate next line
    for (i = 0; i < Math.min(rawList.length, maxLines); ++i) {
        hostList.push(rawList[i].split(";")); // server Max Money in [0], server name position [1], hack level in [2], portsNeeded in [3], server ram in [4]
    }
    return hostList;
}


function getHackToolsLevel(ns) {
    // set curent hack tools level
    player.toolsLevel = 0; // count hacking tools to set this level
    var hackTools = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
    var i = 0; // looper


    for (i = 0; i < hackTools.length; ++i) {
        if (ns.fileExists(hackTools[i], "home"))++player.toolsLevel;
    }
    ns.print("Our hacking tools level is (out of max 5) :" + player.toolsLevel);
    return player.toolsLevel;
}


function scanTargets(ns, targetList) {
    // scans for hackable servers
    // requires 2D array of potential targets:  money[0], name[1], hackLevel[2], portsNeeded[3] , ram[4]
    var scanAbortLevel = 5; // factor that caps out server evaluations
    var targetCount = targetList.length || 0; // retunr 0 as default if not yet defined
    var lastScanCount = activeTargets.length;
    var newTargets = 0; // new targets found
    var transferServer; // used to transfer server to hacking group
    var serversAdded = 0; // number of servers co-opted in to farming
    var toolsFailCount = 0; // number of servers we could have hacked but tools level too low
    var levelFailCount = 0; // fails due to server level too high
    var possibleTarget = [];
    var i = 0; // looper

    activeTargets = []; // reset for new scan
    droneTotalRam = 0;  // reset for new san

    ns.print("Identified potential targets :" + targetCount);
    ns.print("Screening for new targets within our abilities ....");
    player.hackLevel = ns.getHackingLevel();
    player.toolsLevel = getHackToolsLevel(ns);

    for (i = 0; i < (targetCount - 1); ++i) {
        // possibleTarget[i] = new Target( ...targetList[i]); // debug - trying to use array directly in constructor did not work
        // possibleTarget[i] = new Target.apply( this, targetList[i] );// debug - this did not work
        // possibleTarget[i] = new Target.construct( targetList[i] ); // debug - this did not work
        possibleTarget[i] = new Target(parseInt(targetList[i][0]), targetList[i][1], parseInt(targetList[i][2]), parseInt(targetList[i][3]), parseInt(targetList[i][4]));
        // possibleTarget[i].maxMoney = targetList[i][0];
        // possibleTarget[i].name = targetList[i][1];
        // possibleTarget[i].level = targetList[i][2];
        // possibleTarget[i].ports = targetList[i][3];
        // possibleTarget[i].ram = targetList[i][4];
        // debug
        // ns.print("Evaluated data :" + targetList[i].toString());
        // ns.print("Evaluating .constructor #" + i + possibleTarget[i].constructor); // debug - did not work
        ns.print("Evaluating #" + i + " >" + possibleTarget[i].name + ", level :" + possibleTarget[i].level + ", ports needed :" + possibleTarget[i].ports + ", ram:" + possibleTarget[i].ram);
        // debug
        if (player.hackLevel >= possibleTarget[i].level) {
            if (player.toolsLevel >= possibleTarget[i].ports) {
                if (!ns.hasRootAccess(possibleTarget[i].name)) {
                    openCan(ns, possibleTarget[i]);
                }
                activeTargets.push(possibleTarget[i]); // add hacked server to activeTargets list
                ++serversAdded;
                droneTotalRam += possibleTarget[i].ram;

                if (basicFileSet.length > 0 && !ns.fileExists(basicFileSet[basicFileSet.length - 1], possibleTarget[i].name)) {
                    ns.scp(basicFileSet, "home", possibleTarget[i].name);
                    ns.print("Basic set of files copied to target");
                }
            } else {
                ++toolsFailCount;
            }
        } else {
            ++levelFailCount;
            if (levelFailCount > scanAbortLevel) break;
            // break out if scanning - remaining servers at too high hack level
        }
    }
    // pass one server over to hacking group as soon as money hacking starts
    if (hackingServers.length == 3) {
        transferServer = activeTargets.shift();
        droneTotalRam -= transferServer.ram;
    }

    newTargets = (serversAdded - lastScanCount);
    ns.print("New servers hacked and deployed for farming :" + newTargets + ". Total combined RAM now: " + droneTotalRam);
    if (toolsFailCount > 0) ns.tprint("ALERT: Servers hackable but too few tools :" + toolsFailCount);
    return serversAdded;
}


function openCan(ns, targetHost) {
    // hack targetHost if possible
    // will transfer (global) basicFileSet[]  of files to target if exisists
    var hackResult;

    switch (targetHost.ports) {
        case 5:
            ns.httpworm(targetHost.name);
        //fallthrough
        case 4:
            ns.sqlinject(targetHost.name);
        //fallthrough
        case 3:
            ns.relaysmtp(targetHost.name);
        //fallthrough
        case 2:
            ns.ftpcrack(targetHost.name);
        //fallthrough
        case 1:
            ns.brutessh(targetHost.name);
        //fallthrough
        case 0:
            ns.nuke(targetHost.name);
    }

    if (ns.hasRootAccess(targetHost.name)) {
        hackResult = true;
        ns.tprint("Hack of " + targetHost.name + " succesfull");
    } else {
        ns.tprint("Hack of " + targetHost.name + " failed - " + targetHost.ports + " open ports required.");
        hackResult = false;
    }
    return hackResult;
}


function checkNewDrones(ns) {
    // scan for more jobs and assign them after hack skill increase
    var dronesAdded = false; // check if new drones added
    var rescanThreshold = (player.hackLevel <= 150) ? rescanIncrements : rescanIncrements * 2;
    player.hackLevel = ns.getHackingLevel();

    if (player.hackLevel >= (playerHackLevelLastScan + rescanThreshold)) {
        dronesAdded = (scanTargets(ns, hostList) > 0);
        playerHackLevelLastScan = player.hackLevel;
        ns.print("Next scan will be at +- hack level: " + (player.hackLevel + rescanThreshold));
    }
    return dronesAdded;
}


function profileServer(ns, server, serverName) {
    // add static paramaters to server object
    // serverName is mandatory

    if (serverName === undefined) {
        ns.tprint("WARNING !! fn: profileServer called without first assigning Target.name");
        exit;
    }
    server.name = serverName;
    server.level = ns.getServerRequiredHackingLevel(serverName);
    server.maxMoney = ns.getServerMaxMoney(serverName);
    server.minSecurity = ns.getServerMinSecurityLevel(serverName);
    server.baseSecurity = ns.getServerBaseSecurityLevel(serverName);
    server.growthRate = ns.getServerGrowth(serverName);

    server.moneyAvailable = ns.getServerMoneyAvailable(server.name);
    server.hackTime = ns.getHackTime(server.name);
    server.growthTime = ns.getGrowTime(server.name);
    server.weakenTime = ns.getWeakenTime(server.name);
    player.hackLevel = ns.getHackingLevel();
    server.hasBeenProfiled = true;

    return;
}


async function clearAll(ns, serverList) {
    // kill all scripts on these servers
    var usedRam = 0;
    var serversCleared = 0;
    var i = 0; // looper

    for (i = 0; i < serverList.length; ++i) {
        usedRam = ns.getServerRam(serverList[i].name)[1];
        if (usedRam > 0) {
            ns.killall(serverList[i].name);
            ++serversCleared;
        }
    }
    // confirm server is clear
    for (i = 0; i < serverList.length; ++i) {
        while (ns.getServerRam(serverList[i].name)[1] > 0) {
            // wait  
            await ns.sleep(200);
        }
    }

    return serversCleared;
}


async function weakenServerToMin(ns, server) {
    // weaken server to minimum
    var timeToWeaken = 0;
    var minSecAchieved = false;
    var weakenThreads = 0; // used to calculate thread requirments
    // var threadsAdded = 0; // threads assign

    clearAll(ns, activeTargets); // kill all scripts on all drones
    // check secLevel before running first reduce
    logStats(ns, server);
    server.currentSecLevel = ns.getServerSecurityLevel(server.name);
    if (server.currentSecLevel > server.minSecurity) {
        ns.tprint(">> Softening server " + server.name + " to minimum security. Currently at :" + asPercentage(securityPercentage(ns, server)) + " [Elapsed Time: " + elapsedMinutes() + "]");
        weakenThreads = fillDroneCapacity(ns, weakenScript, server);
        timeToWeaken = (Math.floor(((server.currentSecLevel - server.baseSecurity) / weakenRate) / weakenThreads + 1) * ns.getWeakenTime(server.name)) / 60;
        ns.tprint(">> Weakening server " + server.name + " to minimum: " + server.minSecurity + " . Currently at " + asPercentage(securityPercentage(ns, server)));
        ns.tprint(">> This should take around mins: " + twoDecimals(timeToWeaken));
        while (!minSecAchieved) {
            // wait for security level to drop to min
            if (checkNewDrones(ns)) {
                fillDroneCapacity(ns, weakenScript, server);
            } else { await ns.sleep(512); } // can we scan for new drones
            await ns.sleep(10000);
            server.currentSecLevel = ns.getServerSecurityLevel(server.name);
            (server.currentSecLevel === server.minSecurity) ? minSecAchieved = true : minSecAchieved = false;
            logStats(ns, server);
        }
    } else {
        minSecAchieved = true;
    }
    ns.tprint(">> Server at minimum security: " + server.name + " (" + asPercentage(securityPercentage(ns, server)) + "). [Elapsed Time: " + elapsedMinutes() + "]");
    logStats(ns, server);
    return minSecAchieved;
}


function securityPercentage(ns, server) {
    // return security level of server as percentage
    return Math.floor(((ns.getServerSecurityLevel(server.name) - server.minSecurity) / (server.baseSecurity - server.minSecurity)) * 100) / 100; // percentage to tww decimals
}


function moneyPercentage(ns, server) {
    // return money level of server as percentage
    return Math.floor((ns.getServerMoneyAvailable(server.name) / server.maxMoney) * 100) / 100; // percentage to tww decimals
}


function killScript(ns, paramString) {
    // kill specific script
    var paramArray = paramString.split(",");
    return ns.kill(paramArray[0], paramArray[1], paramArray[2], paramArray[3]);
}


function twoDecimals(n) {
    // round off to two decimals
    // replaced by number.toFixed(n-decimals)
    return (Math.round(n * 100) / 100);
}

function asDollar(n) {
    //display formated as currency to two decimals
    return ("$" + (n).toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,'));
}


function asPercentage(n) {
    // display as percentage with three decimals
    return ((Math.round(n * 100000) / 1000) + "%");
}


function startTimer() {
    // start the clock to meaasure elapsedTime
    startTime = new Date();
    return startTime;
}


function elapsedMinutes() {
    // measure minutes elapsed from StartTime
    var endTime = new Date();
    var timeDiff = endTime - startTime; //in ms
    // round off minutes 
    var rawMinutes = timeDiff / (1000 * 60);
    var minutesPortion = Math.floor(rawMinutes);
    // get seconds as remainder
    var secondsPortion = Math.round((rawMinutes - minutesPortion) * 60);
    // create formatted output mmss
    return (minutesPortion + "m" + secondsPortion + "s");
}


function logStats(ns, server) {
    // log stats to file for later analysis
    var time = (Date.now() / (1000 * 60)).toFixed(1);
    var pMoney = ns.getServerMoneyAvailable("home");
    var pHackLevel = ns.getHackingLevel();
    var pToolsLevel = player.toolsLevel;
    var sName = server.name;
    var sMoneyPerc = moneyPercentage(ns, server);
    var sSecurityPerc = securityPercentage(ns, server);
    var dataLog = [time, pMoney, pHackLevel, pToolsLevel, sName, sMoneyPerc, sSecurityPerc];
    ns.write(logFileName, (dataLog.toString() + "\n"), ns.mode = "a"); // append to new line
}

