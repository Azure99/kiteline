#include <errno.h>
#include <stdio.h>

int main(int argc, char **argv) {
    if (argc != 3) {
        fputs("usage: rename-noreplace SOURCE TARGET\n", stderr);
        return 2;
    }
    if (renamex_np(argv[1], argv[2], RENAME_EXCL) == 0)
        return 0;
    int error = errno;
    fprintf(stderr, "%d\n", error);
    return 1;
}
