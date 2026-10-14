#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif

static volatile sig_atomic_t interrupted;
enum { drain_timeout_ms = 1000 };

static void interrupt(int signal_number) { interrupted = signal_number; }

static int64_t now_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags == -1 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static uint32_t length(const unsigned char *data) {
  return (uint32_t)data[0] << 24 | (uint32_t)data[1] << 16 |
         (uint32_t)data[2] << 8 | data[3];
}

int main(int argc, char **argv) {
  if (argc < 6) {
    fprintf(stderr, "Usage: pty-bridge COLS ROWS INPUT_LIMIT OUTPUT_LIMIT COMMAND [ARG...]\n");
    return 1;
  }
  struct winsize size = {0};
  size.ws_col = (unsigned short)atoi(argv[1]);
  size.ws_row = (unsigned short)atoi(argv[2]);
  size_t input_limit = (size_t)strtoul(argv[3], NULL, 10);
  size_t output_limit = (size_t)strtoul(argv[4], NULL, 10);
  if (!size.ws_col || !size.ws_row || input_limit < 4 || !output_limit) {
    fprintf(stderr, "Invalid PTY dimensions or buffer limits\n");
    return 1;
  }
  unsigned char *input = malloc(input_limit + 5);
  unsigned char *output = malloc(output_limit);
  if (!input || !output) {
    fprintf(stderr, "Cannot allocate PTY buffers\n");
    free(input);
    free(output);
    return 1;
  }
  int master;
  pid_t child = forkpty(&master, NULL, NULL, &size);
  if (child == -1) {
    perror("forkpty");
    free(input);
    free(output);
    return 1;
  }
  if (child == 0) {
    execv(argv[5], &argv[5]);
    perror("exec PTY client");
    _exit(127);
  }
  signal(SIGPIPE, SIG_IGN);
  signal(SIGTERM, interrupt);
  signal(SIGINT, interrupt);
  signal(SIGHUP, interrupt);

  const char *failure = NULL;
  size_t received = 0, expected = 5, input_written = 0;
  size_t output_start = 0, output_size = 0;
  int status = 0, reaped = 0, stopping = 0, killed = 0;
  int64_t deadline = 0;
  if (nonblocking(0) == -1 || nonblocking(1) == -1 || nonblocking(master) == -1)
    failure = "Cannot make PTY bridge descriptors nonblocking";

  for (;;) {
    int64_t now = now_ms();
    if (!reaped) {
      pid_t result = waitpid(child, &status, WNOHANG);
      if (result == child) {
        reaped = 1;
        if (!deadline) deadline = now + drain_timeout_ms;
      } else if (result == -1 && errno != EINTR) {
        failure = "Cannot reap PTY client";
        break;
      }
    }
    if (interrupted && !failure) failure = "PTY bridge interrupted";
    if (failure && !stopping) {
      stopping = 1;
      if (master != -1) close(master);
      master = -1;
      output_size = 0;
      if (!reaped) kill(child, SIGHUP);
      deadline = now + drain_timeout_ms;
    }
    if (reaped && master == -1 && !output_size) break;
    if (stopping && !reaped && !killed && now >= deadline - 500) {
      kill(child, SIGKILL);
      killed = 1;
    }
    if (deadline && now >= deadline) {
      if (stopping) break;
      failure = "PTY client did not finish draining output";
      continue;
    }

    // stdin: type ('I' bytes or 'R' resize), uint32 BE length, then payload.
    // Only one input frame is buffered. A blocked PTY write must not stop output reads.
    struct pollfd descriptors[] = {
      {stopping || reaped || received == expected ? -1 : 0, POLLIN, 0},
      {output_size ? 1 : -1, POLLOUT, 0},
      {master, POLLIN | (received == expected && input[0] == 'I' ? POLLOUT : 0), 0},
    };
    int polled = poll(descriptors, 3, deadline ? 25 : 100);
    if (polled == -1) {
      if (errno == EINTR) continue;
      failure = "PTY bridge poll failed";
      continue;
    }
    if (descriptors[1].revents) {
      ssize_t count = write(1, output + output_start, output_size);
      if (count > 0) {
        output_start += (size_t)count;
        output_size -= (size_t)count;
        if (!output_size) output_start = 0;
      } else if (count == -1 && errno != EAGAIN && errno != EINTR)
        failure = "Cannot write PTY output";
    }
    if (descriptors[2].revents & (POLLIN | POLLHUP | POLLERR)) {
      unsigned char data[65536];
      ssize_t count = read(master, data, sizeof(data));
      if (count > 0) {
        if ((size_t)count > output_limit - output_size)
          failure = "PTY output transmission backlog exceeds the limit";
        else {
          if (output_start + output_size + (size_t)count > output_limit) {
            memmove(output, output + output_start, output_size);
            output_start = 0;
          }
          memcpy(output + output_start + output_size, data, (size_t)count);
          output_size += (size_t)count;
        }
      } else if (!count || (count == -1 && errno == EIO)) {
        close(master);
        master = -1;
        if (!deadline) deadline = now_ms() + drain_timeout_ms;
      } else if (errno != EAGAIN && errno != EINTR)
        failure = "Cannot read PTY output";
    }
    if (descriptors[0].revents) {
      ssize_t count = read(0, input + received, expected - received);
      if (count > 0) {
        received += (size_t)count;
        if (received == 5) {
          uint32_t bytes = length(input + 1);
          if ((input[0] != 'I' && input[0] != 'R') || bytes > input_limit ||
              !bytes || (input[0] == 'R' && bytes != 4))
            failure = "Invalid PTY input frame";
          else expected = 5 + bytes;
        }
      } else if (!count)
        failure = "PTY input closed";
      else if (errno != EAGAIN && errno != EINTR)
        failure = "Cannot read PTY input";
    }
    if (failure) continue;
    if (received == expected && master != -1) {
      if (input[0] == 'R') {
        size.ws_col = (unsigned short)((unsigned)input[5] << 8 | input[6]);
        size.ws_row = (unsigned short)((unsigned)input[7] << 8 | input[8]);
        if (!size.ws_col || !size.ws_row || ioctl(master, TIOCSWINSZ, &size) == -1)
          failure = "Cannot resize PTY";
        received = input_written = 0;
        expected = 5;
      } else if (descriptors[2].revents & POLLOUT) {
        ssize_t count = write(master, input + 5 + input_written, expected - 5 - input_written);
        if (count > 0) {
          input_written += (size_t)count;
          if (input_written == expected - 5) {
            received = input_written = 0;
            expected = 5;
          }
        } else if (count == -1 && errno != EAGAIN && errno != EINTR)
          failure = "Cannot write PTY input";
      }
    }
  }
  if (master != -1) close(master);
  if (!reaped) {
    kill(child, SIGKILL);
    failure = "PTY client cleanup timed out";
  }
  free(input);
  free(output);
  if (failure) {
    fprintf(stderr, "%s\n", failure);
    return 1;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
