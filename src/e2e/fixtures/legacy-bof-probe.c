#include <stdint.h>

__declspec(dllimport) void BeaconOutput(int32_t type, char *data, int32_t length);

void go(char *args, int32_t length) {
    static char marker[] = "sliver-gui-legacy-bof-probe-ok";
    (void)args;
    (void)length;
    BeaconOutput(0, marker, (int32_t)(sizeof(marker) - 1));
}
