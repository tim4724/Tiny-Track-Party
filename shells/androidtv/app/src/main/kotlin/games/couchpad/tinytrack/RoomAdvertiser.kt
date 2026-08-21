package games.couchpad.tinytrack

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.net.ServerSocket

/**
 * CouchPad room advertisement (launcher CONTRACT §8, `docs/native-port/shells.md`
 * item 10): publishes the open room over DNS-SD so a launcher on a phone in the
 * same house offers a one-tap join with no QR scan and no typed code. The tvOS
 * twin is `Net/RoomAdvertiser.swift`.
 *
 * THE ROOM CODE IS THE ENTIRE PAYLOAD. The launcher resolves it against the
 * relay — the same `GET {relayBase}/room/{code}` probe a typed code takes — and
 * that answer, never the LAN, supplies the join URL, the display's platform tag
 * and whether the room is still open. So an advertisement can NAME a room but
 * cannot propose an origin: there is no host to re-validate and no way to point
 * a launcher at an arbitrary page. That is why the record carries no URL, and
 * why this display still declares itself in exactly one place — the
 * controller-URL template `create-room` registers, with [PartyNet.CP_PLATFORM].
 *
 * No version key either: `_couchpad._tcp` plus a code some relay knows IS the
 * gate, and a record without a usable `c` is ignored. A later revision adds keys
 * that old launchers skip; a shape they must not read at all takes a new service
 * type.
 *
 * The launcher never dials the SRV port. `NsdManager` needs a port to register,
 * so a throwaway [ServerSocket] supplies one that nothing serves.
 *
 * The instance name is the TV's own name ("Spielzimmer"), which the launcher
 * shows verbatim so a player with two boxes can tell the rooms apart. It never
 * leaves the LAN: the relay is told the platform and nothing else.
 *
 * ALL OF IT IS AN ACCELERATOR, NEVER THE ONLY ROUTE IN. mDNS is blocked on
 * AP-isolated and guest networks, so every failure here is logged and swallowed,
 * and the on-screen QR and room code remain the universal way in.
 *
 * NO PERMISSION IS DECLARED, and that is a `targetSdk` fact rather than a
 * permanent one: Local Network Protections are enforced only for apps targeting
 * API 37, and this one targets 36. **Re-check when targetSdk moves** — if
 * registration needs `ACCESS_LOCAL_NETWORK` there, discovery of this display
 * stops with nothing but the warning below to say so. The fastlane's ICE host
 * candidates sit behind the same gate.
 *
 * Threading: unlike the tvOS twin, whose caller is `@MainActor` throughout, this
 * one is reachable from the game thread as well as Main, so both entry points
 * are `@Synchronized`. A `withdraw()` racing an `advertise()` could otherwise
 * interleave so the registration lands AFTER the unregister — leaving a record
 * (and its socket) alive for a room the display has already left, with
 * `advertisedRoom` then making the next `advertise()` a no-op so nothing ever
 * takes it down.
 */
class RoomAdvertiser(context: Context) {

    private val appContext = context.applicationContext
    private val nsd = appContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private var listener: NsdManager.RegistrationListener? = null
    private var socket: ServerSocket? = null
    private var advertisedRoom: String? = null

    /**
     * Publish [room], replacing any live record. IDEMPOTENT: the sync that drives
     * this rides every roster movement, and re-registering the same code on each
     * one would churn the network for nothing.
     */
    @Synchronized
    fun advertise(room: String) {
        if (room == advertisedRoom && listener != null) return
        withdraw()
        val nsd = nsd ?: return
        if (room.isEmpty()) return
        val registration = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                // NsdManager renames on a name clash, so this is the label
                // actually on the wire.
                Log.i(TAG, "advertising as ${info.serviceName}")
            }

            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "advertise failed: $errorCode")
            }

            override fun onServiceUnregistered(info: NsdServiceInfo) {}
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
        }
        runCatching {
            val sock = ServerSocket(0)
            val info = NsdServiceInfo().apply {
                serviceName = deviceLabel()
                serviceType = SERVICE_TYPE
                port = sock.localPort
                setAttribute(CODE_KEY, room)
            }
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration)
            socket = sock
            listener = registration
            advertisedRoom = room
        }.onFailure {
            Log.w(TAG, "advertise refused to start: ${it.message}")
            withdraw()
        }
    }

    /**
     * Withdraw the record (an mDNS goodbye — records at TTL 0). A record that
     * outlives its room is harmless on its face — the code resolves to nothing
     * and no card appears — but it costs a player a wasted tap, so there is no
     * reason to leave one up.
     */
    @Synchronized
    fun withdraw() {
        listener?.let { runCatching { nsd?.unregisterService(it) } }
        listener = null
        runCatching { socket?.close() }
        socket = null
        advertisedRoom = null
    }

    /**
     * The TV's own name, as the owner set it; the model is the fallback on a box
     * that has none — which includes every box below API 25, where the setting
     * does not exist. `DEVICE_NAME` is a compile-time String constant, so it
     * inlines and the minSdk-24 call is just a lookup that answers null.
     */
    private fun deviceLabel(): String {
        val name = runCatching {
            Settings.Global.getString(appContext.contentResolver, Settings.Global.DEVICE_NAME)
        }.getOrNull()
        return name?.trim()?.takeIf { it.isNotEmpty() } ?: Build.MODEL
    }

    private companion object {
        const val TAG = "RoomAdvertiser"

        /**
         * The contract's service type. NsdManager's convention includes the
         * trailing dot and Bonjour's omits it; same record on the wire.
         *
         * Not in `protocol.js`: that manifest is for numbers TWO layers of THIS
         * game must agree on, and this one is owned by the launcher contract and
         * read by no other layer here — the web display cannot advertise at all,
         * which is why §6's typed code stays universal.
         */
        const val SERVICE_TYPE = "_couchpad._tcp."

        /** TXT key for the room code (§8). The whole record. */
        const val CODE_KEY = "c"
    }
}
