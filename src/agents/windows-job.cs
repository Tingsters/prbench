// Own one invocation, including descendants which outlive their original parent.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class WindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public IntPtr reserved, desktop, title; public int x,y,cx,cy,xChars,yChars,fill,flags;
    public short show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT value,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(ch); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  public static int Main(string[] args) {
    IntPtr job = IntPtr.Zero, environment = IntPtr.Zero, inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    try {
      // A live process handle prevents PID reuse from redirecting the watchdog.
      var parent = Process.GetProcessById(Int32.Parse(args[0]));
      if (parent.HasExited || parent.StartTime > Process.GetCurrentProcess().StartTime) throw new Exception("Controller already exited.");
      var parentHandle = parent.Handle;
      var serializer = new JavaScriptSerializer { MaxJsonLength = 128 * 1024 * 1024 };
      var input = new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false,true));
      var envelope = serializer.Deserialize<Dictionary<string,object>>(input.ReadToEnd());
      var argv = (System.Collections.IEnumerable)envelope["cmd"];
      var command = new StringBuilder();
      foreach (object arg in argv) { if (command.Length > 0) command.Append(' '); command.Append(Quote((string)arg)); }
      job = CreateJobObject(IntPtr.Zero,null); Check(job != IntPtr.Zero);
      var limits = new EXTENDED_LIMIT(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
      var sa = new SECURITY_ATTRIBUTES { length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit=true };
      Check(CreatePipe(out inputRead,out inputWrite,ref sa,0));
      Check(SetHandleInformation(inputWrite,1,0));
      var si = new STARTUPINFO { cb=Marshal.SizeOf(typeof(STARTUPINFO)), flags=0x100, input=inputRead, output=GetStdHandle(-11), error=GetStdHandle(-12) };
      object envValue;
      var env = envelope.TryGetValue("env",out envValue) ? envValue as Dictionary<string,object> : null;
      if (env != null) {
        var keys = new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
        var block = new StringBuilder();
        foreach (string key in keys) if (env[key] != null) block.Append(key).Append('=').Append((string)env[key]).Append('\0');
        block.Append('\0'); environment = Marshal.StringToHGlobalUni(block.ToString());
      }
      Check(CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x4 | 0x400 | 0x08000000,environment,(string)envelope["cwd"],ref si,out pi));
      Check(AssignProcessToJobObject(job,pi.process));
      CloseHandle(inputRead); inputRead = IntPtr.Zero;
      var watchJob = job;
      var watchdog = new Thread(() => { WaitForSingleObject(parentHandle,0xffffffff); TerminateJobObject(watchJob,130); Environment.Exit(130); });
      watchdog.IsBackground = true; watchdog.Start();
      Check(ResumeThread(pi.thread) != 0xffffffff);
      var prompt = Encoding.UTF8.GetBytes((string)envelope["prompt"]);
      using (var pipe = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(inputWrite,true),FileAccess.Write)) {
        inputWrite = IntPtr.Zero;
        try { pipe.Write(prompt,0,prompt.Length); } catch (IOException) { /* Child may reject input. */ }
      }
      WaitForSingleObject(pi.process,0xffffffff);
      uint code; Check(GetExitCodeProcess(pi.process,out code));
      // Keep the controller outside this job; credential return can run afterward.
      TerminateJobObject(job,code);
      return unchecked((int)code);
    } catch (Exception error) {
      Console.Error.WriteLine("prbench process ownership failed: " + error.Message);
      if (job != IntPtr.Zero) TerminateJobObject(job,125);
      // Assignment failure must not leave the initially suspended child alive.
      if (pi.process != IntPtr.Zero) TerminateProcess(pi.process,125);
      return 125;
    } finally {
      if (inputRead != IntPtr.Zero) CloseHandle(inputRead);
      if (inputWrite != IntPtr.Zero) CloseHandle(inputWrite);
      if (pi.thread != IntPtr.Zero) CloseHandle(pi.thread);
      if (pi.process != IntPtr.Zero) CloseHandle(pi.process);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
    }
  }
}
