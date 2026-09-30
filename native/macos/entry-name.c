#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/attr.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2) {
        fputs("usage: entry-name PATH\n", stderr);
        return 2;
    }
    struct attrlist attributes = {0};
    attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
    attributes.commonattr = ATTR_CMN_NAME;
    unsigned char buffer[4096];
    if (getattrlist(argv[1], &attributes, buffer, sizeof(buffer),
                    FSOPT_NOFOLLOW | FSOPT_REPORT_FULLSIZE) != 0) {
        int error = errno;
        fprintf(stderr, "%d\n", error);
        return 1;
    }
    // Attribute references are relative to their own position in the returned record.
    uint32_t length;
    attrreference_t reference;
    memcpy(&length, buffer, sizeof(length));
    if (length < sizeof(length) + sizeof(reference) || length > sizeof(buffer))
        return 3;
    memcpy(&reference, buffer + sizeof(length), sizeof(reference));
    int64_t offset = (int64_t)sizeof(length) + reference.attr_dataoffset;
    if (offset < (int64_t)(sizeof(length) + sizeof(reference)) ||
        reference.attr_length == 0 || offset + reference.attr_length > length)
        return 3;
    const char *name = (const char *)buffer + offset;
    if (name[reference.attr_length - 1] != '\0' ||
        memchr(name, '\0', reference.attr_length - 1) != NULL)
        return 3;
    if (fwrite(name, 1, reference.attr_length - 1, stdout) != reference.attr_length - 1 ||
        fflush(stdout) != 0)
        return 4;
    return 0;
}
