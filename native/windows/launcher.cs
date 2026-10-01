using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class __KITELINE_LAUNCHER_TYPE__ : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Overlap { public IntPtr a,b; public uint low,high; public IntPtr evt; }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public uint cb; public IntPtr reserved,desktop,title; public uint x,y,width,height,xChars,yChars,fill,flags;
        public ushort show,reservedBytes; public IntPtr reservedData,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup start; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active;
        public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
    delegate bool ConsoleHandler(uint kind);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool LockFileEx(IntPtr handle,uint flags,uint reserved,uint low,uint high,ref Overlap overlap);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(ConsoleHandler handler,bool add);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref JobLimit info,uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
    static bool Valid(IntPtr handle) { return handle!=IntPtr.Zero && handle!=new IntPtr(-1); }
    // Reserved for launcher ownership failure in the download script's managed command boundary.
    const int FatalExitCode=125;
    static void CheckJob(bool ok,string operation) {
        if(ok) return;
        var error=new Win32Exception(Marshal.GetLastWin32Error(),operation);
        try { Console.Error.WriteLine("Launcher Job ownership failed: "+error); }
        catch {}
        finally { Environment.Exit(FatalExitCode); }
    }
    static bool Empty(IntPtr job) {
        Accounting members;
        CheckJob(QueryInformationJobObject(job,1,out members,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero),"query launcher process set");
        return members.active==0;
    }
    static void StopJob(IntPtr job) {
        CheckJob(TerminateJobObject(job,1),"clean remaining launcher processes");
        while(!Empty(job)) Thread.Sleep(10);
    }
    static string Quote(string value) {
        if(value.IndexOf('\0')>=0) throw new ArgumentException("Process argument contains NUL");
        var result=new StringBuilder("\""); int slashes=0;
        foreach(char ch in value) {
            if(ch=='\\') { slashes++; continue; }
            result.Append('\\',ch=='"' ? slashes*2+1 : slashes); result.Append(ch); slashes=0;
        }
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
    readonly ConsoleHandler handler;
    int interrupted;
    public int Interrupted { get { return Volatile.Read(ref interrupted); } }
    public __KITELINE_LAUNCHER_TYPE__() {
        handler=Signal;
        Check(SetConsoleCtrlHandler(handler,true),"register launcher console handler");
    }
    bool Signal(uint kind) {
        if(kind>1) return false;
        Interlocked.CompareExchange(ref interrupted,kind==0 ? 130 : 131,0);
        return true;
    }
    public bool Confirm(string prompt) {
        if(Console.IsInputRedirected) throw new InvalidOperationException("Interactive confirmation is required, or explicitly pass --yes");
        Console.Write(prompt);
        var input=new StringBuilder();
        while(Interrupted==0) {
            if(!Console.KeyAvailable) { Thread.Sleep(25); continue; }
            var key=Console.ReadKey(true);
            if(key.Key==ConsoleKey.Enter) { Console.WriteLine(); return input.ToString()=="yes"; }
            if(key.Key==ConsoleKey.Backspace) {
                if(input.Length>0) { input.Length--; Console.Write("\b \b"); }
            } else if(!char.IsControl(key.KeyChar) && input.Length<16) {
                input.Append(key.KeyChar); Console.Write(key.KeyChar);
            }
        }
        Console.WriteLine();
        return false;
    }
    public void Dispose() { Check(SetConsoleCtrlHandler(handler,false),"remove launcher console handler"); }
    public sealed class Lease : IDisposable {
        IntPtr handle;
        internal Lease(IntPtr value) { handle=value; }
        public void Dispose() {
            if(handle==IntPtr.Zero) return;
            Check(CloseHandle(handle),"close installation lock");
            handle=IntPtr.Zero;
        }
    }
    public Lease Lock(string path,bool shared) {
        var security=new Security(); security.length=Marshal.SizeOf<Security>();
        IntPtr handle=CreateFileW(path,shared ? 0x80000000u : 0xc0000000u,3,ref security,3,0,IntPtr.Zero);
        Check(Valid(handle),"open installation lock");
        var overlap=new Overlap();
        if(!LockFileEx(handle,shared ? 1u : 3u,0,1,0,ref overlap)) {
            int error=Marshal.GetLastWin32Error(); CloseHandle(handle);
            throw new Win32Exception(error,"Installation is busy; no running process was stopped");
        }
        return new Lease(handle);
    }
    public int Run(string executable,string bootstrap,string[] arguments,string directory) {
        if(Interrupted!=0) return Interrupted;
        var security=new Security(); security.length=Marshal.SizeOf<Security>();
        IntPtr pin=CreateFileW(directory,0x81,3,ref security,3,0x02000000,IntPtr.Zero);
        Check(Valid(pin),"pin installation directory");
        security.inherit=1;
        IntPtr attrs=IntPtr.Zero,handleList=IntPtr.Zero,job=IntPtr.Zero,jobList=IntPtr.Zero;
        var streams=new IntPtr[3]; bool initialized=false,completed=false;
        var process=new ProcessInfo();
        Exception failure=null;
        try {
            job=CreateJobObjectW(IntPtr.Zero,null); Check(Valid(job),"create launcher Job");
            var limits=new JobLimit(); limits.basic.flags=0x2000;
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<JobLimit>()),"protect launcher process set");
            for(int i=0;i<3;i++) {
                var original=GetStdHandle(-10-i);
                if(Valid(original)) Check(DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),out streams[i],0,true,2),"inherit console handle");
                else { streams[i]=CreateFileW("NUL",i==0 ? 0x80000000u : 0x40000000u,3,ref security,3,0,IntPtr.Zero); Check(Valid(streams[i]),"open console fallback"); }
            }
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
            attrs=Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attrs,2,0,ref size),"initialize launch attributes"); initialized=true;
            handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
            for(int i=0;i<3;i++) Marshal.WriteIntPtr(handleList,i*IntPtr.Size,streams[i]);
            Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"restrict inherited handles");
            jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
            Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"set atomic launcher Job");
            var startup=new StartupEx(); startup.start.cb=(uint)Marshal.SizeOf<StartupEx>(); startup.attributes=attrs; startup.start.flags=0x100;
            startup.start.input=streams[0]; startup.start.output=streams[1]; startup.start.error=streams[2];
            var command=new StringBuilder(Quote(executable)).Append(" -e ").Append(Quote(bootstrap)).Append(" --");
            foreach(string argument in arguments) command.Append(' ').Append(Quote(argument));
            if(Interrupted!=0) return Interrupted;
            Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x80004,IntPtr.Zero,null,ref startup,out process),"start native Node");
            if(Interrupted!=0) Check(TerminateProcess(process.process,(uint)Interrupted),"cancel early startup");
            else Check(ResumeThread(process.thread)!=0xffffffff,"resume native Node");
            Check(WaitForSingleObject(process.process,0xffffffff)==0,"wait for native Node");
            uint code; Check(GetExitCodeProcess(process.process,out code),"read native Node result");
            if(!Empty(job)) {
                StopJob(job);
                throw new InvalidOperationException("Node exited with live child processes; the remaining process set was terminated");
            }
            completed=true;
            return unchecked((int)code);
        } catch(Exception error) { failure=error; throw; }
        finally {
            try {
                if(Valid(process.process) && !completed) {
                    StopJob(job);
                    Check(WaitForSingleObject(process.process,0xffffffff)==0,"wait after launcher failure");
                }
            } catch(Exception cleanup) {
                if(failure!=null) throw new AggregateException("Launcher execution and cleanup failed",failure,cleanup);
                throw;
            } finally {
                if(Valid(process.thread)) CheckJob(CloseHandle(process.thread),"close launcher thread");
                if(Valid(process.process)) CheckJob(CloseHandle(process.process),"close launcher process");
                if(initialized) DeleteProcThreadAttributeList(attrs);
                if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs);
                if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if(Valid(job)) CheckJob(CloseHandle(job),"close launcher Job");
                foreach(var stream in streams) if(Valid(stream)) CloseHandle(stream);
                CloseHandle(pin);
            }
        }
    }
}
