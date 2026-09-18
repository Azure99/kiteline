#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3) {
        fputs("usage: rename-noreplace SOURCE TARGET\n", stderr);
        return 2;
    }
    if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_NOREPLACE) == 0)
        return 0;
    int error = errno;
    fprintf(stderr, "%d\n", error);
    return 1;
}
